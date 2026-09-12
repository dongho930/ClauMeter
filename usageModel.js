// 사용자 개인의 "구간 경과율(%) -> 그 시점까지 쓴 금액이 최종 금액의 몇 %였는지" 곡선을
// 과거에 실제로 끝난 구간들로부터 학습(피팅)해서, 지금 페이스가 이어질 경우 구간이 끝날 때
// 최종적으로 얼마를 쓰게 될지 예측하는 모듈.
//
// 진행 중인 구간의 값은 아직 "최종값"이 아니라서 그 자체로 학습에 쓰지 않는다. 대신 진행 중에는
// 경과율별 누적 비용 샘플만 버퍼에 모아두고, 그 구간이 실제로 끝나는 시점(closeWindow)에만
// 버퍼를 최종 비용 기준으로 정규화해서 학습(버킷 평균 갱신)에 반영한다.
//
// 예측은 두 단계다: (1) 학습된 곡선으로 "이 페이스가 이어지면" 얼마가 될지 구하고,
// (2) 유휴시간(마지막 사용 이후 경과)으로 "애초에 페이스가 이어질지"를 보정한다.
// (2)가 없으면 이미 사용이 끝난 구간도 계속 더 쓸 것처럼 예측해서 구조적으로 과대예측된다.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// __dirname은 설치된 앱에서는 읽기 전용 app.asar 내부를 가리키므로 쓸 수 없다 -
// 반드시 Electron의 실제 쓰기 가능한 사용자 데이터 폴더를 써야 한다.
const DATA_DIR = app.getPath('userData');
const MODEL_PATH = path.join(DATA_DIR, 'usage_model.json');
const BUCKET_COUNT = 101; // 경과율 0% ~ 100%, 1% 단위
// 1구간만 쌓여도 모델을 켠다 - predictFromState의 신뢰도 블렌딩(표본이 적으면 단순가정 쪽으로
// 자동으로 끌어당김)이 데이터 부족 시 과신을 막아주므로, 굳이 여러 구간을 기다릴 필요가 없다.
const MIN_WINDOWS_FOR_MODEL = 1;
const EMA_MIN_ALPHA = 0.15; // 표본이 많이 쌓인 뒤에도 최근 구간에 최소 이만큼의 가중치를 유지 (오래된 습관 변화에 계속 적응)
const CONFIDENCE_K = 4; // 버킷 표본수가 이 값일 때 모델 신뢰도가 50%가 되도록 하는 평활 상수
const HISTORY_LIMIT = 30; // 예측 정확도 검증 로그 보관 개수
// 학습 방식이 바뀌면 올린다. 저장된 모델의 버전이 다르면 예전 곡선은 더 이상 같은 의미가 아니므로
// 버리고 처음부터 다시 배운다. (v2: 주간 구간을 실제 초기화 시각 격자에 맞춰 백필하도록 수정 -
// v1의 주간 곡선은 경과율 축이 실시간 구간과 어긋난 채 학습돼 있어 그대로 쓸 수 없다.)
const MODEL_VERSION = 2;

function emptyKindState() {
  return {
    completedWindows: 0,
    buckets: Array.from({ length: BUCKET_COUNT }, () => ({ mean: 0, count: 0 })),
    history: [], // 구간이 끝날 때마다 "그 직전 예측 vs 실제 최종값"을 기록해 정확도를 검증하는 로그
  };
}

let state = null;
const buffers = { fiveHour: new Map(), weekly: new Map() }; // bucket(0~100) -> 그 시점 누적비용, 진행 중인 구간에만 사용

function emptyState() {
  return { version: MODEL_VERSION, fiveHour: emptyKindState(), weekly: emptyKindState() };
}

function loadState() {
  if (state) return state;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
  } catch {
    raw = null;
  }
  // 버전이 없거나(v1) 다르면 학습을 폐기한다. 호출부(main.js)도 같은 버전을 보고 백필을 다시 돌린다.
  if (!raw || raw.version !== MODEL_VERSION) {
    state = emptyState();
    return state;
  }
  state = {
    version: MODEL_VERSION,
    fiveHour: { ...emptyKindState(), ...raw.fiveHour },
    weekly: { ...emptyKindState(), ...raw.weekly },
  };
  return state;
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MODEL_PATH, JSON.stringify(state));
  } catch {
    // 다음 저장 시점에 재시도
  }
}

// 정확도 검증을 수행할 경과율. 구간 중간쯤이어야 "이 페이스면 어디까지 갈지"를 실제로 묻게 된다.
const EVAL_FRAC = 0.5;

// 버퍼에 실제로 샘플이 있는 버킷 중 target에 가장 가까운 것. (앱이 구간 내내 켜져 있지 않았을 수 있다.)
function nearestBucketTo(buf, target) {
  let best = null;
  for (const b of buf.keys()) {
    if (best == null || Math.abs(b - target) < Math.abs(best - target)) best = b;
  }
  return best;
}

function bucketOf(elapsedFrac) {
  const clamped = Math.max(0, Math.min(1, elapsedFrac));
  return Math.round(clamped * (BUCKET_COUNT - 1));
}

// 진행 중인 구간의 샘플을 버퍼에 남긴다. 아직 학습하지는 않는다.
// idleSec은 이 시점의 유휴시간(마지막 사용 이후 경과) - 구간이 끝날 때 정확도 로그를 남기는 데 쓴다.
function recordSample(kind, elapsedFrac, cumulativeCost, idleSec) {
  if (!Number.isFinite(cumulativeCost) || cumulativeCost < 0) return;
  buffers[kind].set(bucketOf(elapsedFrac), { cost: cumulativeCost, idleSec: idleSec != null ? idleSec : null });
}

// 유휴시간으로 "이 구간의 사용이 이미 끝났는지"를 0~1로 추정한다. 1이면 아직 작업 중(곡선 예측을
// 그대로 신뢰), 0이면 사실상 종료(최종값 = 현재값).
//
// 곡선 모델만으로는 "이미 끝난 구간"을 표현할 수 없는 게 과대예측의 구조적 원인이다. 학습된 곡선의
// 평균은 결코 1.0이 되지 않는데, 실제로는 경과율 50% 시점에 이미 소비가 끝나있는 구간이 절반이 넘어서
// (측정: t=0.5에서 53%, t=0.9에서 87%) 그 구간들은 무조건 과대예측된다.
//
// 임계값은 실측된 P(추가 지출 발생)보다 항상 보수적으로(=더 높게) 잡았다. 실측은 유휴 30~45분에서
// 44%, 45~60분 40%, 60~120분 19%, 120분 이상에서는 41건 중 0건이었다. 즉 증거가 확실한 "2시간 이상"
// 에서만 종료로 단정하고, 애매한 구간에서는 기존처럼 넉넉히(과대예측 쪽으로) 남겨둔다.
const IDLE_FULLY_ACTIVE_SEC = 30 * 60;
const IDLE_FINISHED_SEC = 120 * 60;

// 5시간 한도에서만 쓴다 - 주간 구간에서 2시간 쉬는 건 아무 의미가 없고, 주 단위로 보정하려면
// 완료된 주간 구간이 훨씬 많이 필요한데 현재는 그만한 표본이 없다.
const IDLE_AWARE_KINDS = { fiveHour: true, weekly: false };

function activityFactor(kind, idleSec) {
  if (!IDLE_AWARE_KINDS[kind] || idleSec == null || !Number.isFinite(idleSec)) return 1;
  if (idleSec <= IDLE_FULLY_ACTIVE_SEC) return 1;
  if (idleSec >= IDLE_FINISHED_SEC) return 0;
  return 1 - (idleSec - IDLE_FULLY_ACTIVE_SEC) / (IDLE_FINISHED_SEC - IDLE_FULLY_ACTIVE_SEC);
}

// elapsedFrac(0~1)에 해당하는 위치를 표본이 있는 양옆 버킷 사이에서 선형 보간한다.
// 한쪽에만 표본이 있으면 그 값을 그대로 쓰고, 양쪽 다 없으면 null.
function interpolateBucket(kindState, clampedFrac) {
  const pos = clampedFrac * (BUCKET_COUNT - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);

  let leftIdx = null;
  for (let i = lo; i >= 0; i--) {
    if (kindState.buckets[i].count > 0) {
      leftIdx = i;
      break;
    }
  }
  let rightIdx = null;
  for (let i = hi; i < BUCKET_COUNT; i++) {
    if (kindState.buckets[i].count > 0) {
      rightIdx = i;
      break;
    }
  }

  if (leftIdx == null && rightIdx == null) return null;
  if (leftIdx == null) return kindState.buckets[rightIdx];
  if (rightIdx == null) return kindState.buckets[leftIdx];
  if (leftIdx === rightIdx) return kindState.buckets[leftIdx];

  const l = kindState.buckets[leftIdx];
  const r = kindState.buckets[rightIdx];
  const t = (pos - leftIdx) / (rightIdx - leftIdx);
  return {
    mean: l.mean + (r.mean - l.mean) * t,
    count: l.count + (r.count - l.count) * t, // 신뢰도 계산용으로 표본수도 함께 보간
  };
}

// kindState(학습된 곡선)만으로 예측한다. completedWindows 임계값 체크는 호출부 책임.
// 버킷 표본수가 적을수록(신뢰도 낮을수록) "경과율 = 최종비용 대비 비율"이라는 단순 가정 쪽으로
// 점점 더 끌어당겨서(가중 블렌딩) 데이터가 부족한 구간에서 모델이 과신하지 않게 한다.
function predictFromState(kindState, elapsedFrac, currentCost) {
  const clamped = Math.max(0, Math.min(1, elapsedFrac));
  const found = interpolateBucket(kindState, clamped);
  if (!found) return null;

  const confidence = found.count / (found.count + CONFIDENCE_K);
  const blendedMean = confidence * found.mean + (1 - confidence) * clamped;
  // 경과율이 0%에 가까울 때는 비율이 너무 작아 나눗셈이 불안정해지므로 제외한다.
  if (blendedMean <= 0.01) return null;

  return currentCost / blendedMean;
}

// 구간이 실제로 끝났을 때 호출한다. 버퍼에 쌓인 샘플들을 finalCost 기준으로 정규화해서
// "경과율 -> 누적비율" 곡선(버킷별 EMA)에 반영하고, 다음 구간을 위해 버퍼를 비운다.
// 학습에 반영하기 직전에, 이번 구간의 마지막 샘플을 "그때까지의 모델"로 미리 예측해보고
// 실제 finalCost와 비교한 결과를 history에 남긴다 (예측 정확도 검증용).
function closeWindow(kind, finalCost) {
  const buf = buffers[kind];
  const st = loadState();
  const kindState = st[kind];

  if (finalCost > 0 && buf.size > 0) {
    // 구간의 마지막 샘플에서 검증하면 안 된다 - 그 시점엔 이미 최종값이 거의 확정돼 있어서
    // 어떤 예측이든 다 맞는 것처럼 보인다. 예측이 실제로 쓸모 있는 구간 중간에서 검증한다.
    const evalBucket = nearestBucketTo(buf, bucketOf(EVAL_FRAC));
    const evalSample = buf.get(evalBucket);
    const evalCost = evalSample.cost;
    const elapsedFracAtLast = evalBucket / (BUCKET_COUNT - 1);

    // 정확도 로그는 화면에 보이는 예측과 같은 방식으로 남겨야 의미가 있으므로 유휴 보정까지 적용한다.
    const curvePred =
      kindState.completedWindows >= MIN_WINDOWS_FOR_MODEL && evalCost > 0
        ? predictFromState(kindState, elapsedFracAtLast, evalCost)
        : null;
    const modelPred =
      curvePred != null ? evalCost + activityFactor(kind, evalSample.idleSec) * (curvePred - evalCost) : null;
    const naivePred = elapsedFracAtLast > 0.01 && evalCost > 0 ? evalCost / elapsedFracAtLast : null;

    kindState.history = kindState.history || [];
    kindState.history.push({
      closedAt: Date.now(),
      elapsedFracAtLast: Math.round(elapsedFracAtLast * 1000) / 1000,
      finalCost,
      modelPred,
      naivePred,
      modelErrorPct: modelPred != null ? Math.round(((modelPred - finalCost) / finalCost) * 1000) / 10 : null,
      naiveErrorPct: naivePred != null ? Math.round(((naivePred - finalCost) / finalCost) * 1000) / 10 : null,
    });
    if (kindState.history.length > HISTORY_LIMIT) kindState.history.shift();

    for (const [bucket, sample] of buf.entries()) {
      const fraction = Math.min(1, sample.cost / finalCost);
      const b = kindState.buckets[bucket];
      b.count += 1;
      // 표본이 적을 때는 단순 평균처럼 빠르게 수렴하고, 많이 쌓인 뒤에도 EMA_MIN_ALPHA 만큼은
      // 항상 최근 구간에 가중치를 남겨서 오래된 습관에 영원히 묶이지 않게 한다.
      const alpha = Math.max(1 / b.count, EMA_MIN_ALPHA);
      b.mean += (fraction - b.mean) * alpha;
    }
    kindState.completedWindows += 1;
    saveState();
  }

  buf.clear();
}

// 고정 격자(주간)의 위상 - 초기화 시각을 구간 길이로 나눈 나머지만이 격자 위치를 결정한다.
// 몇 주가 밀렸는지는 격자와 무관하다. 백필이 자르는 기준과 같은 규칙이라 여기에 둔다.
function windowPhaseOf(resetAtMs, windowMs) {
  return resetAtMs == null ? null : ((resetAtMs % windowMs) + windowMs) % windowMs;
}

// 두 위상이 사실상 같은 격자인지. 실측 초기화 시각이 매주 몇 분씩 흔들려도 그때마다 학습을
// 버리지 않도록 허용 오차를 둔다. 위상은 0과 windowMs가 맞닿은 원형이라 원형 거리로 비교한다.
function isSameWindowPhase(a, b, windowMs, toleranceMs) {
  if (a == null || b == null) return false;
  const diff = Math.abs(a - b);
  return Math.min(diff, windowMs - diff) <= toleranceMs;
}

// 한 한도의 학습을 통째로 버린다. 구간 경계를 자르는 기준(주간 초기화 시각의 위상)이 바뀌어서
// 이미 배운 곡선의 경과율 축이 더 이상 같은 의미가 아닐 때, 다시 백필하기 전에 호출한다.
function resetKind(kind) {
  const st = loadState();
  st[kind] = emptyKindState();
  buffers[kind].clear();
  saveState();
}

// 현재 경과율/누적비용/유휴시간을 바탕으로 구간 종료 시 최종 비용을 예측한다.
// 학습된 구간이 충분하지 않으면 null을 반환해서 호출부가 단순 선형 예측으로 대체하게 한다.
//
// 곡선 예측은 항상 현재 비용 이상이므로(누적비율 <= 1), 활동도만큼만 현재값에서 위로 끌어올린다.
// 활동도 1이면 곡선 예측 그대로, 0이면 "이미 끝난 구간"으로 보고 최종값 = 현재값.
function predictFinalCost(kind, elapsedFrac, currentCost, idleSec) {
  const st = loadState();
  const kindState = st[kind];
  if (kindState.completedWindows < MIN_WINDOWS_FOR_MODEL) return null;
  const curvePred = predictFromState(kindState, elapsedFrac, currentCost);
  if (curvePred == null) return null;
  return currentCost + activityFactor(kind, idleSec) * (curvePred - currentCost);
}

// 최근 구간들에서 모델 예측과 단순 선형 예측이 각각 실제값 대비 평균적으로 얼마나 틀렸는지 반환한다.
// UI에서 "개선되고 있는지" 확인하는 용도. 기록이 없으면 null.
function getAccuracyStats(kind) {
  const st = loadState();
  const history = (st[kind] && st[kind].history) || [];
  if (history.length === 0) return null;

  let modelSum = 0;
  let modelN = 0;
  let naiveSum = 0;
  let naiveN = 0;
  for (const h of history) {
    if (h.modelErrorPct != null) {
      modelSum += Math.abs(h.modelErrorPct);
      modelN += 1;
    }
    if (h.naiveErrorPct != null) {
      naiveSum += Math.abs(h.naiveErrorPct);
      naiveN += 1;
    }
  }

  return {
    sampleCount: history.length,
    modelMeanAbsErrorPct: modelN > 0 ? Math.round((modelSum / modelN) * 10) / 10 : null,
    naiveMeanAbsErrorPct: naiveN > 0 ? Math.round((naiveSum / naiveN) * 10) / 10 : null,
  };
}

// 과거 사용 기록으로 모델을 즉시 학습시킨다. 실시간으로 구간이 여러 번 끝날 때까지(특히 주간은
// 몇 주) 기다리지 않고, 이미 쌓여 있던 기록만으로 모델이 바로 쓰이기 시작하게 하기 위함.
//
// 구간 경계를 어떻게 자르느냐가 핵심이다 - 학습한 곡선의 x축(경과율)이 실시간 예측에서 쓰는 x축과
// 같은 기준이 아니면 엉뚱한 위치에 학습된다. 두 한도는 경계 규칙이 서로 다르므로 따로 처리한다.
//   - 5시간: 구간이 끝난 뒤 "처음 발생한 이벤트"에서 새 구간이 시작된다 (anchorSec 없이 호출).
//   - 주간: 실제 초기화 시각(cfg.weekResetAt)에서 7일 간격으로 고정된 격자다 (anchorSec 필수).
//     첫 이벤트를 시작점으로 잡으면 실시간 구간과 위상이 어긋난다.
//
// events: [{ts(초 단위 epoch), cost}], windowSec: 구간 길이(초), nowSec: 현재 시각(초 단위 epoch),
// anchorSec: (주간 전용) 격자 기준 시각(초). 아직 끝나지 않은 구간은 학습에서 제외한다.
// 반환값: 실제로 학습에 반영된(비용이 0보다 컸던) 구간 수.
function backfillFromEvents(kind, windowSec, events, nowSec, anchorSec) {
  if (!events || events.length === 0) return 0;
  const sorted = events.slice().sort((a, b) => a.ts - b.ts);

  // 진행 중인 구간의 실시간 샘플 버퍼를 백필이 덮어쓰지 않도록 잠시 빼뒀다가 끝나면 되돌린다.
  // (주간 백필은 weekResetAt을 알게 된 뒤에야 실행되므로 앱이 이미 돌고 있는 중일 수 있다.)
  const liveBuffer = buffers[kind];
  buffers[kind] = new Map();
  try {
    return anchorSec != null
      ? backfillOnGrid(kind, windowSec, sorted, nowSec, anchorSec)
      : backfillByFirstEvent(kind, windowSec, sorted, nowSec);
  } finally {
    buffers[kind] = liveBuffer;
  }
}

// 한 구간의 이벤트 목록을 실시간 폴링과 같은 모양의 샘플로 바꿔 학습시킨다.
//
// 이벤트 시점에만 샘플을 남기면 실시간(1초 폴링)과 모양이 달라져서 두 가지가 깨진다.
//   (1) 이벤트 사이의 "안 쓴 구간"이 통째로 빠져서, 보간이 비용을 실제보다 완만하게 퍼뜨린다.
//   (2) 마지막 샘플이 구간 끝이 아니라 마지막 이벤트 위치가 되어, 정확도 로그가 실시간 기록과
//       같은 기준으로 비교되지 않는다.
// 그래서 버킷을 처음부터 끝까지 훑으면서 그 시점의 누적 비용과 유휴시간을 그대로 남긴다.
function learnWindowFromEvents(kind, windowStart, windowSec, ev) {
  let running = 0;
  let idx = 0;
  let lastEventTs = null;

  for (let b = 0; b < BUCKET_COUNT; b++) {
    const at = windowStart + (b / (BUCKET_COUNT - 1)) * windowSec;
    while (idx < ev.length && ev[idx].ts <= at) {
      running += ev[idx].cost;
      lastEventTs = ev[idx].ts;
      idx += 1;
    }
    recordSample(kind, b / (BUCKET_COUNT - 1), running, lastEventTs == null ? null : at - lastEventTs);
  }

  closeWindow(kind, running);
  return running > 0;
}

// 5시간 한도 방식: 구간이 끝나면 그 구간 밖의 첫 이벤트에서 다음 구간이 새로 시작된다.
function backfillByFirstEvent(kind, windowSec, sorted, nowSec) {
  let cursor = 0;
  let learned = 0;

  while (cursor < sorted.length) {
    const windowStart = sorted[cursor].ts;
    const windowEnd = windowStart + windowSec;
    if (windowEnd > nowSec) break; // 아직 끝나지 않았을 수 있는 구간은 학습에 넣지 않는다

    let i = cursor;
    while (i < sorted.length && sorted[i].ts < windowEnd) i += 1;
    if (learnWindowFromEvents(kind, windowStart, windowSec, sorted.slice(cursor, i))) learned += 1;
    cursor = i; // 실제 한도처럼, 다음 구간은 이 구간 밖의 첫 이벤트에서 새로 시작
  }

  return learned;
}

// 주간 한도 방식: anchorSec에서 windowSec 간격으로 고정된 격자를 그대로 따라간다.
// 이벤트가 하나도 없는 칸(예: 쉬었던 주)은 최종 비용이 0이라 closeWindow가 학습에서 제외한다.
function backfillOnGrid(kind, windowSec, sorted, nowSec, anchorSec) {
  // 가장 오래된 이벤트가 속한 격자 칸부터 시작한다 (anchorSec은 보통 미래라 몫이 음수가 된다).
  let windowStart = anchorSec + Math.floor((sorted[0].ts - anchorSec) / windowSec) * windowSec;
  let cursor = 0;
  let learned = 0;

  while (windowStart + windowSec <= nowSec) {
    const windowEnd = windowStart + windowSec;
    let i = cursor;
    while (i < sorted.length && sorted[i].ts < windowEnd) i += 1;
    if (learnWindowFromEvents(kind, windowStart, windowSec, sorted.slice(cursor, i))) learned += 1;
    cursor = i;
    windowStart = windowEnd;
  }

  return learned;
}

module.exports = {
  recordSample,
  closeWindow,
  predictFinalCost,
  getAccuracyStats,
  backfillFromEvents,
  resetKind,
  windowPhaseOf,
  isSameWindowPhase,
  MIN_WINDOWS_FOR_MODEL,
  MODEL_VERSION,
};
