// statuslineBridge.js가 남겨놓은 realtime_usage.json(Anthropic 서버가 계산한 실제 한도 %)을 읽는다.
// 이 파일은 사용자가 터미널에서 Claude Code 세션을 열어 상태줄이 그려질 때만 갱신된다. 마지막으로
// 캡처된 값이라도 그 구간(resetsAt)이 아직 끝나지 않았다면 여전히 유효한 실측값이므로 계속 보여준다 -
// 위젯을 껐다 켜거나 터미널을 한동안 안 열어도 다음 갱신이 있을 때까지 마지막 실측값을 유지한다.
// 구간이 실제로 끝난(resetsAt이 지난) 뒤에는 값이 의미가 없으므로 그때만 null로 돌려서
// main.js가 "데이터 없음"으로 표시하게 한다.
const fs = require('fs');
const path = require('path');

const REALTIME_PATH = path.join(__dirname, 'realtime_usage.json');

function read() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(REALTIME_PATH, 'utf-8'));
  } catch {
    return { fiveHour: null, weekly: null };
  }

  const now = Date.now();

  const fiveHour =
    raw.fiveHour && typeof raw.fiveHour.resetsAt === 'number' && now < raw.fiveHour.resetsAt ? raw.fiveHour : null;
  const weekly =
    raw.weekly && typeof raw.weekly.resetsAt === 'number' && now < raw.weekly.resetsAt ? raw.weekly : null;

  return { fiveHour, weekly };
}

module.exports = { read };
