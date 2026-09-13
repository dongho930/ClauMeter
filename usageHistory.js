// Anthropic 서버가 계산한 실제 한도 %(realtime_usage.json)의 이력을 남긴다.
//
// 이 파일이 필요한 이유: 실측 %는 상태줄이 갱신될 때마다 realtime_usage.json에 "덮어쓰기"로만
// 남아서 지나간 값을 볼 방법이 없었다. 그래서 예측 모델의 평가는 전부 비용(estimated_cost_usd)을
// 한도 소모의 대리 지표로 삼아 왔는데, 그 대리 관계가 성립하는지 자체를 확인할 수 없었다.
//
// 이력이 없어서 답하지 못한 질문들:
//   - Opus와 Sonnet은 $1당 한도를 같은 비율로 깎는가? (다르면 페이스 배율을 실측 %에 그대로
//     곱하는 지금 방식이 모델을 섞어 쓸 때 왜곡된다)
//   - 주간 예측이 실제로 얼마나 빗나가는가? (완료된 주간 구간이 하나뿐이라 비용만으로는 불가)
//   - 비용 기준으로 학습한 곡선이 실제 한도 소모 곡선과 같은 모양인가?
//
// 기록 자체는 아무 동작도 바꾸지 않는다. 표본이 쌓인 뒤 tools/eval-model.js가 읽어서 위 질문에
// 답하기 위한 것이다. 한 줄이 한 번의 상태줄 캡처에 대응한다(JSONL).

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DATA_DIR = app.getPath('userData');
const HISTORY_PATH = path.join(DATA_DIR, 'usage_history.jsonl');

// 주간 구간이 충분히 쌓이도록 넉넉히 보관한다 (120일 = 주간 구간 약 17개).
const RETENTION_MS = 120 * 86400 * 1000;
const MAX_RECORDS = 20000;

let lastCapturedAt = null; // 같은 캡처를 중복 기록하지 않기 위한 표식
let compacted = false;

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.capturedAt === 'number') out.push(obj);
    } catch {
      // 쓰다 만 줄은 버린다
    }
  }
  return out;
}

function readAll() {
  try {
    return parseLines(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

// 앱 실행당 한 번, 보관 기간이 지났거나 너무 많이 쌓인 기록을 정리한다.
function compactOnce() {
  if (compacted) return;
  compacted = true;
  let records = readAll();
  if (records.length === 0) return;

  const cutoff = Date.now() - RETENTION_MS;
  const kept = records.filter((r) => r.capturedAt >= cutoff).slice(-MAX_RECORDS);
  if (kept.length !== records.length) {
    try {
      fs.writeFileSync(HISTORY_PATH, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch {
      // 다음 실행에서 다시 시도
    }
  }
  lastCapturedAt = kept.length ? kept[kept.length - 1].capturedAt : null;
}

// realtimeUsage.read()의 결과를 그대로 받는다. 상태줄이 새로 캡처한 값일 때만 한 줄 남긴다.
// 위젯 폴링은 1초마다 돌지만 상태줄은 터미널이 다시 그려질 때만 갱신되므로 기록은 드물게 쌓인다.
function record(realtime) {
  if (!realtime || typeof realtime.capturedAt !== 'number') return;
  compactOnce();
  if (realtime.capturedAt === lastCapturedAt) return;

  // 구간이 이미 끝난 값은 realtimeUsage가 null로 걸러주므로 여기 오는 건 유효한 실측값뿐이다.
  const entry = { capturedAt: realtime.capturedAt };
  if (realtime.fiveHour) {
    entry.fiveHourPct = realtime.fiveHour.usedPercentage;
    entry.fiveHourResetAt = realtime.fiveHour.resetsAt;
  }
  if (realtime.weekly) {
    entry.weeklyPct = realtime.weekly.usedPercentage;
    entry.weeklyResetAt = realtime.weekly.resetsAt;
  }
  if (entry.fiveHourPct == null && entry.weeklyPct == null) return;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n');
    lastCapturedAt = realtime.capturedAt;
  } catch {
    // 다음 캡처에서 재시도 (lastCapturedAt을 갱신하지 않으므로 자연히 다시 시도된다)
  }
}

// 기록된 실측 이력 전체를 캡처 시각 순으로 반환한다. 평가 도구용.
function getAll() {
  return readAll().sort((a, b) => a.capturedAt - b.capturedAt);
}

// ---------------------------------------------------------------------------
// 두 한도를 잇는 환산 비율: 5시간 %p 1만큼 쓸 때 주간 %p가 얼마나 깎이는가.
//
// 같은 사용이 두 게이지를 동시에 깎으므로 둘은 고정 비율로 묶여 있다. 이 비율을 알면 "남은 주간
// 여유 = 5시간 구간 몇 번분"처럼 두 한도를 하나의 단위로 환산할 수 있다.
//
// 상수로 박지 않고 사용자별로 학습한다 - 요금제나 Opus/Sonnet 비중에 따라 달라질 수 있는데,
// 지금 표본으로는 그 영향을 분리할 수 없기 때문이다. 대신 표본이 부실하면 아예 null을 돌려줘서
// 호출부가 환산 표시를 숨기게 한다(예측 데드존과 같은 원칙).
//
// 측정(2026-09-13, 5시간 구간 5개): 0.085 ~ 0.111, 중앙값 0.102. 즉 5시간을 꽉 채우면 주간이
// 약 10%p 깎이고, 주간 한도는 5시간 구간 약 10번분이다.

// 주간 %는 정수로 반올림돼 들어온다. 5시간 변화폭이 작으면 그 ±0.5%p가 비율을 통째로 흔들어서
// (변화폭 9%p면 비율 오차가 ±0.055 - 값 자체만 한 크기다) 변화폭이 큰 구간만 표본으로 쓴다.
const RATIO_MIN_FIVE_HOUR_DELTA = 50;
const RATIO_MIN_SAMPLES = 2;
const RATIO_CACHE_MS = 10 * 60 * 1000; // 이력 전체를 다시 파싱하므로 1초 폴링마다 돌릴 수 없다

let ratioCache = null; // { value, computedAt }

// 한 5시간 구간 안의 기록들에서 (5시간 변화량, 주간 변화량) 한 쌍을 뽑는다. 쓸 수 없으면 null.
function ratioSampleOf(group) {
  const usable = group.filter((r) => r.fiveHourPct != null && r.weeklyPct != null);
  if (usable.length < 2) return null;

  const first = usable[0];
  const last = usable[usable.length - 1];
  // 구간 도중에 주가 바뀌면 주간 %가 0으로 떨어져서 변화량이 음수가 된다 - 그 구간은 버린다.
  if (first.weeklyResetAt !== last.weeklyResetAt) return null;

  const deltaFive = last.fiveHourPct - first.fiveHourPct;
  const deltaWeekly = last.weeklyPct - first.weeklyPct;
  if (deltaFive < RATIO_MIN_FIVE_HOUR_DELTA || deltaWeekly < 0) return null;
  return deltaWeekly / deltaFive;
}

// 표본이 적어 평균은 이상치 하나에 끌려가므로 중앙값을 쓴다.
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 5시간 %p 1당 주간 %p. 표본이 부족하면 null.
function getWeeklyPerFiveHourRatio() {
  const now = Date.now();
  if (ratioCache && now - ratioCache.computedAt < RATIO_CACHE_MS) return ratioCache.value;

  const byWindow = new Map();
  for (const r of getAll()) {
    if (r.fiveHourResetAt == null) continue;
    if (!byWindow.has(r.fiveHourResetAt)) byWindow.set(r.fiveHourResetAt, []);
    byWindow.get(r.fiveHourResetAt).push(r);
  }

  const samples = [];
  for (const group of byWindow.values()) {
    const sample = ratioSampleOf(group);
    if (sample != null) samples.push(sample);
  }

  const value = samples.length >= RATIO_MIN_SAMPLES ? median(samples) : null;
  ratioCache = { value, computedAt: now };
  return value;
}

module.exports = { record, getAll, getWeeklyPerFiveHourRatio, HISTORY_PATH };
