// 실측 한도 % 이력 기록(usageHistory.js) 테스트.
//
//   실행: npm test
//
// 이 모듈은 예측 동작을 바꾸지 않고 기록만 한다. 그래서 확인할 것은 "같은 캡처를 중복 기록하지
// 않는가", "쓸 게 없으면 아무것도 남기지 않는가", "보관 기간이 지난 기록을 정리하는가" 세 가지다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PROJECT = path.join(__dirname, '..');
const SRC = path.join(PROJECT, 'usageHistory.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claumeter-hist-'));

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => TMP } },
};

const HISTORY_PATH = path.join(TMP, 'usage_history.jsonl');

function freshModule() {
  delete require.cache[require.resolve(SRC)];
  try {
    fs.unlinkSync(HISTORY_PATH);
  } catch {
    // 첫 실행
  }
  return require(SRC);
}

// realtimeUsage.read()가 돌려주는 모양
const snapshot = (capturedAt, fivePct, weeklyPct) => ({
  capturedAt,
  fiveHour: fivePct == null ? null : { usedPercentage: fivePct, resetsAt: capturedAt + 3600_000 },
  weekly: weeklyPct == null ? null : { usedPercentage: weeklyPct, resetsAt: capturedAt + 86400_000 },
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('상태줄이 새로 캡처한 값만 기록한다', () => {
  const h = freshModule();
  h.record(snapshot(1000, 10, 20));
  h.record(snapshot(1000, 10, 20)); // 같은 캡처 - 위젯 폴링이 1초마다 같은 값을 다시 본 경우
  h.record(snapshot(2000, 15, 21));

  const all = h.getAll();
  assert.strictEqual(all.length, 2, '중복 캡처는 한 번만 기록');
  assert.deepStrictEqual(
    all.map((r) => [r.capturedAt, r.fiveHourPct, r.weeklyPct]),
    [
      [1000, 10, 20],
      [2000, 15, 21],
    ]
  );
});

test('기록할 실측값이 없으면 아무것도 남기지 않는다', () => {
  const h = freshModule();
  h.record(null);
  h.record({});
  h.record(snapshot(1000, null, null)); // 두 구간 모두 이미 끝나 realtimeUsage가 null로 거른 경우
  assert.strictEqual(h.getAll().length, 0);
  assert.strictEqual(fs.existsSync(HISTORY_PATH), false, '파일 자체를 만들지 않는다');
});

test('한쪽 한도만 유효해도 기록한다', () => {
  const h = freshModule();
  h.record(snapshot(1000, 42, null)); // 주간 구간만 만료된 상태
  const all = h.getAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].fiveHourPct, 42);
  assert.strictEqual(all[0].weeklyPct, undefined);
});

test('보관 기간이 지난 기록은 앱 실행 시 정리한다', () => {
  freshModule();
  const now = Date.now();
  const old = now - 200 * 86400 * 1000; // 보관 기간(120일)보다 오래됨
  const recent = now - 86400 * 1000;
  fs.writeFileSync(
    HISTORY_PATH,
    [
      JSON.stringify({ capturedAt: old, fiveHourPct: 1 }),
      JSON.stringify({ capturedAt: recent, fiveHourPct: 2 }),
      '',
      '{ 쓰다 만 줄',
    ].join('\n') + '\n'
  );

  delete require.cache[require.resolve(SRC)];
  const h = require(SRC);
  h.record(snapshot(now, 3, 4)); // compact는 첫 record에서 한 번 수행된다

  const all = h.getAll();
  assert.deepStrictEqual(
    all.map((r) => r.fiveHourPct),
    [2, 3],
    '오래된 기록과 깨진 줄은 사라지고 최근 기록만 남아야 한다'
  );
});

test('캡처 시각이 뒤섞여 저장돼 있어도 시간순으로 돌려준다', () => {
  freshModule();
  fs.writeFileSync(
    HISTORY_PATH,
    [
      JSON.stringify({ capturedAt: Date.now(), fiveHourPct: 2 }),
      JSON.stringify({ capturedAt: Date.now() - 5000, fiveHourPct: 1 }),
    ].join('\n') + '\n'
  );
  delete require.cache[require.resolve(SRC)];
  assert.deepStrictEqual(
    require(SRC)
      .getAll()
      .map((r) => r.fiveHourPct),
    [1, 2]
  );
});

// ---------------------------------------------------------------------------
// 두 한도 환산 비율 (getWeeklyPerFiveHourRatio)
//
// 같은 사용이 5시간/주간 게이지를 동시에 깎는다는 점을 이용해 "5시간 %p 1당 주간 %p"를 학습한다.
// 주간 %는 정수로 반올림돼 들어오므로, 5시간 변화폭이 작은 구간은 비율이 통째로 흔들려 못 쓴다.
// 그래서 확인할 것은 "큰 변화폭만 표본으로 쓰는가", "표본이 모자라면 물러서는가" 두 가지다.

// resetsAt을 직접 지정할 수 있는 스냅샷 - 여러 기록을 같은 5시간 구간에 묶으려면 필요하다.
const snapAt = (capturedAt, fivePct, weeklyPct, fiveResetAt, weeklyResetAt) => ({
  capturedAt,
  fiveHour: { usedPercentage: fivePct, resetsAt: fiveResetAt },
  weekly: { usedPercentage: weeklyPct, resetsAt: weeklyResetAt },
});

// 한 5시간 구간을 처음/끝 두 기록으로 적는다.
function recordWindow(h, t0, fiveResetAt, weeklyResetAt, from, to) {
  h.record(snapAt(t0, from[0], from[1], fiveResetAt, weeklyResetAt));
  h.record(snapAt(t0 + 1000, to[0], to[1], fiveResetAt, weeklyResetAt));
}

test('변화폭이 큰 5시간 구간 2개 이상이면 환산 비율을 학습한다', () => {
  const h = freshModule();
  const W = 9_000_000;
  recordWindow(h, 1000, 100, W, [0, 50], [100, 60]); // 5시간 100%p -> 주간 10%p
  recordWindow(h, 3000, 200, W, [0, 60], [100, 70]);

  assert.ok(Math.abs(h.getWeeklyPerFiveHourRatio() - 0.1) < 1e-9, '5시간 %p 1당 주간 0.1%p');
});

test('표본이 홀수 개면 중앙값을 쓴다 (이상치 한 건에 끌려가지 않게)', () => {
  const h = freshModule();
  const W = 9_000_000;
  recordWindow(h, 1000, 100, W, [0, 0], [100, 10]); // 0.10
  recordWindow(h, 3000, 200, W, [0, 10], [100, 22]); // 0.12
  recordWindow(h, 5000, 300, W, [0, 22], [100, 72]); // 0.50 <- 이상치

  assert.ok(Math.abs(h.getWeeklyPerFiveHourRatio() - 0.12) < 1e-9, '평균 0.24가 아니라 중앙값 0.12');
});

test('5시간 변화폭이 작은 구간은 표본에서 뺀다 (주간 %의 반올림 오차가 비율을 삼킨다)', () => {
  const h = freshModule();
  const W = 9_000_000;
  recordWindow(h, 1000, 100, W, [0, 50], [100, 60]); // 변화폭 100 - 사용
  recordWindow(h, 3000, 200, W, [0, 60], [9, 61]); // 변화폭 9 - 제외
  recordWindow(h, 5000, 300, W, [0, 61], [18, 63]); // 변화폭 18 - 제외

  assert.strictEqual(h.getWeeklyPerFiveHourRatio(), null, '쓸 수 있는 표본이 1개뿐이면 물러선다');
});

test('구간 도중에 주가 바뀌면 그 구간은 버린다 (주간 %가 0으로 떨어져 음수가 된다)', () => {
  const h = freshModule();
  recordWindow(h, 1000, 100, 9_000_000, [0, 50], [100, 60]);
  recordWindow(h, 3000, 200, 9_000_000, [0, 60], [100, 70]);
  // 주간 초기화가 끼어든 구간: 주간 %가 95 -> 3으로 떨어진다
  h.record(snapAt(5000, 0, 95, 300, 9_000_000));
  h.record(snapAt(6000, 100, 3, 300, 9_100_000));

  assert.ok(Math.abs(h.getWeeklyPerFiveHourRatio() - 0.1) < 1e-9, '주가 바뀐 구간은 무시하고 0.1 유지');
});

test('기록이 없으면 환산 비율도 없다', () => {
  const h = freshModule();
  assert.strictEqual(h.getWeeklyPerFiveHourRatio(), null);
});


let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} 통과`);
process.exit(failed === 0 ? 0 : 1);
