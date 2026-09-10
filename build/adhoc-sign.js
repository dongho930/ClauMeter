// 코드 서명 인증서(Apple Developer ID) 없이 macOS 앱을 배포하기 위한 ad-hoc 서명 스크립트.
// package.json의 build.mac.sign에 지정되어 있어서, electron-builder가 macOS에서 서명 단계에 이 함수를 호출한다
// (universal 빌드는 x64/arm64를 합친 최종 앱에 대해 한 번 호출된다).
//
// electron-builder가 번들을 조립하면서 Electron 원본의 서명이 깨지는데, Apple Silicon Mac은 서명이 깨진 앱을
// 인터넷에서 받으면 "손상되었기 때문에 열 수 없습니다"라고만 하고 열 방법을 주지 않는다. 조립이 끝난 앱 전체를
// ad-hoc("-")으로 다시 서명해두면, 사용자는 "확인되지 않은 개발자" 경고를 보고 시스템 설정에서 열 수 있다.
const { execFileSync } = require('child_process');

async function adhocSign(opts) {
  const appPath = opts.app;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
}

module.exports = adhocSign;
module.exports.default = adhocSign;
