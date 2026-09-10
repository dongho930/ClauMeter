const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  usageModelBackfilledAt: null, // 과거 기록으로 개인화 모델을 백필한 시각 - 재실행마다 중복 학습되지 않도록 한 번만 실행
  weekResetAt: null, // 다음 주간 초기화 시각 (ms epoch) - 이 시각을 지나면 자동으로 7일 뒤로 넘어감
  fiveHourResetAt: null, // 현재(또는 마지막) 5시간 구간의 초기화 시각 (ms epoch)
  fiveHourWindowPending: false, // true면 직전 구간이 끝났지만 아직 새 메시지가 없어 다음 구간이 시작 안 된 상태
  windowX: null,
  windowY: null,
  windowOpacity: null, // 사용자가 설정 화면에서 직접 조절한 위젯 투명도(0.2~0.8). null이면 기본값 사용
  autostart: false,
  language: null, // 'ko'/'en'/'es'/'fr'/'de'/'pt' 중 하나. null이면 OS 로케일로 자동 추정
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

module.exports = { loadConfig, saveConfig, DEFAULT_CONFIG };
