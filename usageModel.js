// 사용자 개인의 "구간 경과율(%) -> 그 시점까지 쓴 금액이 최종 금액의 몇 %였는지" 곡선을
// 과거에 실제로 끝난 구간들로부터 학습(피팅)해서, 지금 페이스가 이어질 경우 구간이 끝날 때
// 최종적으로 얼마를 쓰게 될지 예측하는 모듈.
//
// 진행 중인 구간의 값은 아직 "최종값"이 아니라서 그 자체로 학습에 쓰지 않는다. 대신 진행 중에는
// 경과율별 누적 비용 샘플만 버퍼에 모아두고, 그 구간이 실제로 끝나는 시점(closeWindow)에만
// 버퍼를 최종 비용 기준으로 정규화해서 학습(버킷 평균 갱신)에 반영한다.

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, 'usage_model.json');
const BUCKET_COUNT = 101; // 경과율 0% ~ 100%, 1% 단위
// 1구간만 쌓여도 모델을 켠다 - predictFromState의 신뢰도 블렌딩(표본이 적으면 단순가정 쪽으로
// 자동으로 끌어당김)이 데이터 부족 시 과신을 막아주므로, 굳이 여러 구간을 기다릴 필요가 없다.
const MIN_WINDOWS_FOR_MODEL = 1;
const EMA_MIN_ALPHA = 0.15; // 표본이 많이 쌓인 뒤에도 최근 구간에 최소 이만큼의 가중치를 유지 (오래된 습관 변화에 계속 적응)
const CONFIDENCE_K = 4; // 버킷 표본수가 이 값일 때 모델 신뢰도가 50%가 되도록 하는 평활 상수
const HISTORY_LIMIT = 30; // 예측 정확도 검증 로그 보관 개수

function emptyKindState() {
  return {
    completedWindows: 0,
    buckets: Array.from({ length: BUCKET_COUNT }, () => ({ mean: 0, count: 0 })),
    history: [], // 구간이 끝날 때마다 "그 직전 예측 vs 실제 최종값"을 기록해 정확도를 검증하는 로그
  };
}

let state = null;
const buffers = { fiveHour: new Map(), weekly: new Map() }; // bucket(0~100) -> 그 시점 누적비용, 진행 중인 구간에만 사용

function loadState() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
    state = {
      fiveHour: { ...emptyKindState(), ...raw.fiveHour },
      weekly: { ...emptyKindState(), ...raw.weekly },
    };
  } catch {
    state = { fiveHour: emptyKindState(), weekly: emptyKindState() };
  }
  return state;
}

function saveState() {
  try {
    fs.writeFileSync(MODEL_PATH, JSON.stringify(state));
  } catch {
    // 다음 저장 시점에 재시도
  }
}

function bucketOf(elapsedFrac) {
  const clamped = Math.max(0, Math.min(1, elapsedFrac));
  return Math.round(clamped * (BUCKET_COUNT - 1));
}

// 진행 중인 구간의 샘플을 버퍼에 남긴다. 아직 학습하지는 않는다.
function recordSample(kind, elapsedFrac, cumulativeCost) {
  if (!Number.isFinite(cumulativeCost) || cumulativeCost < 0) return;
  buffers[kind].set(bucketOf(elapsedFrac), cumulativeCost);
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
    const lastBucket = Math.max(...buf.keys());
    const lastCost = buf.get(lastBucket);
    const elapsedFracAtLast = lastBucket / (BUCKET_COUNT - 1);

    const modelPred =
      kindState.completedWindows >= MIN_WINDOWS_FOR_MODEL
        ? predictFromState(kindState, elapsedFracAtLast, lastCost)
        : null;
    const naivePred = elapsedFracAtLast > 0.01 ? lastCost / elapsedFracAtLast : null;

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

    for (const [bucket, cost] of buf.entries()) {
      const fraction = Math.min(1, cost / finalCost);
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

// 현재 경과율/누적비용을 바탕으로 이 페이스가 유지될 때 구간 종료 시 최종 비용을 예측한다.
// 학습된 구간이 충분하지 않으면 null을 반환해서 호출부가 단순 선형 예측으로 대체하게 한다.
function predictFinalCost(kind, elapsedFrac, currentCost) {
  const st = loadState();
  const kindState = st[kind];
  if (kindState.completedWindows < MIN_WINDOWS_FOR_MODEL) return null;
  return predictFromState(kindState, elapsedFrac, currentCost);
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

// 이미 캐시에 남아있는 과거 사용 기록(costStore가 들고 있는 최대 8일치 이벤트)으로 모델을
// 즉시 학습시킨다. 실시간으로 구간이 여러 번 끝날 때까지(특히 주간은 몇 주) 기다리지 않고,
// 이미 쌓여 있던 기록만으로 모델이 바로 쓰이기 시작하게 하기 위함.
// 실제 5시간/주간 한도와 같은 방식(구간이 끝나면 그 다음 실제 이벤트에서 새 구간 시작)으로
// 이벤트 타임라인을 구간 단위로 잘라서 순서대로 recordSample + closeWindow를 호출한다.
// events: [{ts(초 단위 epoch), cost}], windowSec: 구간 길이(초), nowSec: 현재 시각(초 단위 epoch).
// 아직 끝나지 않았을 수 있는(지금 진행 중일 수 있는) 마지막 구간은 학습에서 제외한다.
function backfillFromEvents(kind, windowSec, events, nowSec) {
  if (!events || events.length === 0) return 0;
  const sorted = events.slice().sort((a, b) => a.ts - b.ts);
  let cursor = 0;
  let windowsClosed = 0;

  while (cursor < sorted.length) {
    const windowStart = sorted[cursor].ts;
    const windowEnd = windowStart + windowSec;
    if (windowEnd > nowSec) break; // 아직 끝나지 않았을 수 있는 구간은 학습에 넣지 않는다

    let i = cursor;
    let running = 0;
    while (i < sorted.length && sorted[i].ts < windowEnd) {
      running += sorted[i].cost;
      recordSample(kind, (sorted[i].ts - windowStart) / windowSec, running);
      i += 1;
    }
    closeWindow(kind, running);
    windowsClosed += 1;
    cursor = i; // 실제 한도처럼, 다음 구간은 이 구간 밖의 첫 이벤트에서 새로 시작
  }

  return windowsClosed;
}

module.exports = {
  recordSample,
  closeWindow,
  predictFinalCost,
  getAccuracyStats,
  backfillFromEvents,
  MIN_WINDOWS_FOR_MODEL,
};
