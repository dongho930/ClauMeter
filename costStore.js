// Claude Code가 이미 계산해서 남기는 ~/.claude/metrics/costs.jsonl 의
// estimated_cost_usd(세션별 누적 비용)를 읽어, 캐시 토큰 할인 등이 이미
// 반영된 실제 비용 기준으로 사용량을 추적하는 모듈.
//
// costs.jsonl은 한 줄 = 그 시점까지의 세션 누적 비용(스냅샷)이라서,
// 세션별 마지막 누적값을 기억해뒀다가 "새로 늘어난 만큼"만 이벤트로 쌓는다.

const fs = require('fs');
const path = require('path');
const os = require('os');

const COSTS_LOG_PATH = path.join(os.homedir(), '.claude', 'metrics', 'costs.jsonl');
const CACHE_PATH = path.join(__dirname, 'cost_cache.json');
const RETENTION_SECONDS = 8 * 86400; // 8일치만 보관 (주간=7일 롤링 + 여유 1일)

let state = null;

function loadState() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    state = {
      offset: typeof raw.offset === 'number' ? raw.offset : 0,
      mtime: typeof raw.mtime === 'number' ? raw.mtime : 0,
      tail: typeof raw.tail === 'string' ? raw.tail : '',
      sessionTotals: raw.sessionTotals || {},
      events: raw.events || [],
    };
  } catch {
    state = { offset: 0, mtime: 0, tail: '', sessionTotals: {}, events: [] };
  }
  return state;
}

function saveState() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(state));
  } catch {
    // 다음 폴링에서 재시도
  }
}

function scanAndUpdate() {
  const st = loadState();
  const now = Date.now() / 1000;

  let stat;
  try {
    stat = fs.statSync(COSTS_LOG_PATH);
  } catch {
    return; // 로그 파일이 아직 없음 (Claude Code를 아직 안 썼거나 경로가 다름)
  }

  const mtimeSec = stat.mtimeMs / 1000;
  if (mtimeSec === st.mtime && stat.size === st.offset) {
    // 로그 파일 자체가 안 바뀌었으면 대부분의 경우 저장할 것도 없다 - 보관기간이 지나 실제로
    // 이벤트가 잘려나갔을 때만 디스크에 쓴다. 폴링 주기가 짧아져도(1초) 매번 쓰지 않도록 하는 게 핵심.
    const before = st.events.length;
    st.events = st.events.filter((e) => e.ts >= now - RETENTION_SECONDS);
    if (st.events.length !== before) saveState();
    return; // 변경 없음
  }

  let offset = st.offset;
  let tail = st.tail;
  if (stat.size < offset) {
    // 로그가 회전/축소됨 - 처음부터 다시 읽는다.
    offset = 0;
    tail = '';
    st.sessionTotals = {};
  }

  const readSize = stat.size - offset;
  let chunk = '';
  if (readSize > 0) {
    try {
      const fd = fs.openSync(COSTS_LOG_PATH, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, offset);
      fs.closeSync(fd);
      chunk = buf.toString('utf-8');
    } catch {
      return;
    }
  }

  const combined = tail + chunk;
  const lines = combined.split('\n');
  const remainder = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const sessionId = obj.session_id;
    const cost = obj.estimated_cost_usd;
    const tsStr = obj.timestamp;
    if (!sessionId || typeof cost !== 'number' || !tsStr) continue;
    const ts = Date.parse(tsStr) / 1000;
    if (Number.isNaN(ts)) continue;

    const prev = st.sessionTotals[sessionId] || 0;
    const delta = cost - prev;
    if (delta > 0) {
      st.events.push({ ts, cost: delta });
    }
    st.sessionTotals[sessionId] = cost;
  }

  st.offset = stat.size;
  st.mtime = mtimeSec;
  st.tail = remainder;
  st.events = st.events.filter((e) => e.ts >= now - RETENTION_SECONDS);
  saveState();
}

function getCostSince(tsEpoch) {
  const st = loadState();
  let sum = 0;
  for (const e of st.events) {
    if (e.ts >= tsEpoch) sum += e.cost;
  }
  return sum;
}

// [startTsEpoch, endTsEpoch) 구간(초) 사이에 발생한 이벤트만 합산한다. 구간이 끝났을 때
// 그 구간의 최종 비용을 확정하는 데 쓴다 (getCostSince는 상한이 없어 다음 구간 이벤트까지 섞일 수 있음).
function getCostBetween(startTsEpoch, endTsEpoch) {
  const st = loadState();
  let sum = 0;
  for (const e of st.events) {
    if (e.ts >= startTsEpoch && e.ts < endTsEpoch) sum += e.cost;
  }
  return sum;
}

// tsEpoch(초) 이후에 실제로 발생한 첫 사용 이벤트의 시각(초)을 반환한다. 없으면 null.
// 5시간 한도가 "직전 구간 만료 후 처음 메시지를 보낸 시점"에 새로 시작되는 걸 반영하는 데 쓴다.
function getEarliestEventAfter(tsEpoch) {
  const st = loadState();
  let earliest = null;
  for (const e of st.events) {
    if (e.ts > tsEpoch && (earliest == null || e.ts < earliest)) earliest = e.ts;
  }
  return earliest;
}

// 캐시에 남아있는(최대 8일치) 원본 이벤트를 모두 반환한다. 개인화 모델을 과거 기록으로
// 한 번에 백필(backfill)하는 데 쓴다.
function getAllEvents() {
  const st = loadState();
  return st.events.slice();
}

module.exports = {
  scanAndUpdate,
  getCostSince,
  getCostBetween,
  getEarliestEventAfter,
  getAllEvents,
};
