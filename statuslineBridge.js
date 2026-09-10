// Claude Code의 statusLine 훅으로 등록되는 스크립트.
// Claude Code는 인터랙티브 세션이 상태줄을 그릴 때마다 이 스크립트를 실행하면서
// 아래와 같은 JSON을 stdin으로 넘겨준다(문서상 스키마):
//   { "rate_limits": {
//       "five_hour": { "used_percentage": number, "resets_at": number(초) },
//       "seven_day":  { "used_percentage": number, "resets_at": number(초) }
//   } }
// used_percentage/resets_at는 Anthropic 서버가 직접 계산한 실제 한도 수치라서,
// 위젯이 하던 "비용 -> % 추정"보다 훨씬 정확하다. 이 스크립트는 그 값을 그대로
// beta_2 폴더의 realtime_usage.json에 저장해서 위젯(main.js)이 읽게 한다.
//
// 절대 예외를 던지면 안 된다 - 이 스크립트가 죽으면 사용자의 실제 터미널 상태줄이
// 깨지기 때문에, 무슨 일이 있어도 표준출력에 뭔가는 찍어야 한다.
const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, 'realtime_usage.json');

function pick(entry) {
  if (!entry || typeof entry.used_percentage !== 'number' || typeof entry.resets_at !== 'number') return null;
  return { usedPercentage: entry.used_percentage, resetsAt: entry.resets_at * 1000 };
}

try {
  const input = fs.readFileSync(0, 'utf-8');
  const data = JSON.parse(input);
  const rl = (data && data.rate_limits) || {};

  const out = {
    capturedAt: Date.now(),
    fiveHour: pick(rl.five_hour),
    weekly: pick(rl.seven_day),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));

  const parts = [];
  if (out.fiveHour) parts.push(`5h ${Math.round(out.fiveHour.usedPercentage)}%`);
  if (out.weekly) parts.push(`7d ${Math.round(out.weekly.usedPercentage)}%`);
  process.stdout.write(parts.length ? parts.join(' · ') : 'Claude Code');
} catch {
  process.stdout.write('Claude Code');
}
