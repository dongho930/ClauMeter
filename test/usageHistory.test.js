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
