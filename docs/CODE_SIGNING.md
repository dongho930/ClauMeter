# 코드 서명 받는 방법 (Windows · macOS)

클로미터는 지금 코드 서명 없이 배포됩니다. 이 문서는 나중에 정식 서명을 붙이고 싶을 때 필요한 준비물, 비용,
절차, 그리고 이 저장소에서 바꿔야 할 부분을 정리한 것입니다. (2026년 9월 기준으로 조사한 내용이라, 가격과 조건은
신청 전에 각 공식 페이지에서 다시 확인하세요.)

## 한눈에 보기

| | 지금 (서명 없음) | 서명하면 | 비용 |
|---|---|---|---|
| Windows | 설치할 때 SmartScreen "Windows의 PC 보호" 경고 | 게시자 이름이 표시되고, 다운로드가 쌓이면 경고가 사라짐 | 무료(SignPath Foundation) ~ 연 $50 안팎(Certum) |
| macOS | "확인할 수 없음" 경고 + 시스템 설정에서 직접 허용, 자동 업데이트 불가(알림만) | 경고 없이 바로 실행, 자동 업데이트 가능 | 연 $99 (Apple Developer Program) |

## Windows

### 먼저 알아둘 점

- **서명해도 처음에는 경고가 뜰 수 있습니다.** SmartScreen은 인증서 종류보다 "그 파일/게시자가 얼마나 많이 문제없이
  설치됐는지"로 판단합니다. 2024년 3월부터는 비싼 EV 인증서도 즉시 통과시켜 주지 않고 OV와 똑같이 평판을 쌓아야
  하므로, EV를 살 이유는 거의 없습니다.
- **인증서 파일(.pfx)을 받아서 GitHub Secrets에 넣는 방식은 이제 쓸 수 없습니다.** 공개 코드 서명 인증서의 개인키는
  USB 토큰이나 클라우드 HSM 안에만 보관하도록 바뀌어서, CI에서 서명하려면 클라우드 서명 서비스를 써야 합니다.
- **인증서 유효기간이 최대 460일로 줄었습니다** (2026년 3월 1일부터). 여러 해짜리를 사도 1년여마다 재발급해야 합니다.
- **자동 업데이트와의 관계**: 서명된 버전을 한 번 배포하면, electron-builder가 설치본의 `app-update.yml`에 게시자
  이름(`publisherName`)을 적어 넣고 electron-updater가 이후 업데이트 파일의 서명이 같은 게시자인지 검사합니다. 그 뒤로는
  **서명 안 된 업데이트나 게시자 이름이 다른 업데이트는 설치되지 않으므로**, 한번 서명을 시작하면 계속 같은 방식으로
  서명해야 합니다(서명 서비스를 바꿀 때는 `win.signtoolOptions.publisherName`에 이전·새 이름을 함께 적어야 합니다).

### 선택지

#### 1) SignPath Foundation — 무료, 오픈소스 프로젝트용 (추천)

오픈소스 프로젝트에 무료로 코드 서명을 해주는 비영리 재단입니다. 클로미터(MIT 라이선스, 공개 저장소, 이미 릴리스
있음)는 조건에 맞을 가능성이 높습니다.

- **조건**: OSI 승인 라이선스(상업용 이중 라이선스 없이), 모든 구성 요소가 오픈소스, 이미 릴리스된 적 있음, 활발히 유지보수,
  다운로드 페이지에 기능 설명, 악성/원치 않는 프로그램 아님
- **게시자 이름**: 인증서가 **"SignPath Foundation"** 이름으로 발급됩니다. 설치 화면의 게시자에 개인 이름 대신 이 이름이 나옵니다.
- **빌드 조건**: 공개 저장소의 소스에서 CI(GitHub Actions)로 자동 빌드한 결과물만 서명할 수 있습니다.
- **보안 조건**: 팀원 전원이 SignPath와 GitHub에 2단계 인증을 켜야 하고, 서명 요청마다 승인자가 승인해야 합니다.
- **신청**: [signpath.org](https://signpath.org)의 신청서를 작성해 보내고 심사를 기다립니다.

#### 2) Certum Open Source Code Signing — 연 $50 안팎, 개인 이름으로 발급

폴란드 인증기관 Certum의 오픈소스 개발자용 인증서입니다. 게시자에 **본인 이름**이 표시됩니다.

- 클라우드 방식(SimplySign)을 고르면 USB 토큰이 필요 없습니다.
- 신원 확인 서류(신분증 사본, 주소 확인용 공과금 고지서 등)와 활성 오픈소스 프로젝트 URL을 제출합니다.
- SimplySign 로그인에 휴대폰 앱의 일회용 코드가 필요해서, GitHub Actions에서 완전히 자동으로 서명하기는 까다롭습니다.
  릴리스할 때마다 PC에서 직접 서명해서 올리는 흐름이 현실적입니다.

#### 3) 상용 OV 인증서 + 클라우드 서명 (SSL.com eSigner, DigiCert KeyLocker 등)

게시자에 본인(또는 사업자) 이름이 표시되고 GitHub Actions 연동을 공식 지원합니다. 대신 위 두 방법보다 비쌉니다.
사업자로 전환하거나 SignPath 조건이 맞지 않을 때 고려하세요.

#### (참고) Azure Artifact Signing (구 Trusted Signing) — 한국 개인은 불가

월 $9.99로 가장 저렴하고 electron-builder가 직접 지원(`win.azureSignOptions`)하지만, **개인 개발자는 미국·캐나다만**
가입할 수 있습니다. 한국은 조직(사업자)만 가능하고 유료 Azure 구독이 필요합니다.

### 이 저장소에서 바꿀 부분 (SignPath 기준)

1. `.github/workflows/build.yml`의 Windows 빌드 뒤에 SignPath의 GitHub Action으로 서명 요청 → 승인 → 서명된 파일을
   받아오는 단계를 추가합니다.
2. **서명하면 설치 파일의 해시가 바뀌므로 `latest.yml`의 `sha512`/`size`와 `.blockmap`을 서명된 파일로 다시 만들어야
   합니다.** 그렇지 않으면 자동 업데이트가 "파일 검증 실패"로 설치를 거부합니다.
3. 설치 파일 안의 `ClauMeter.exe`와 제거 프로그램까지 서명되도록 SignPath 서명 정책을 설정합니다.

## macOS

### 필요한 것

- **Apple Developer Program 개인 멤버십**: 연 $99 (지역에 따라 원화로 결제될 수 있음)
  - 2단계 인증이 켜진 Apple 계정, 계정 이름이 법적 실명이어야 합니다.
- **Developer ID Application 인증서**: App Store 밖에서 배포하는 앱 서명용. 멤버십의 계정 소유자(Account Holder)만 만들 수 있습니다.
- **공증(notarization) 자격 증명**: Apple ID + 앱 암호, 또는 App Store Connect API 키

Mac이 없어도 아래 절차는 Windows에서 모두 할 수 있고, 실제 서명·공증은 GitHub Actions의 macOS 러너가 합니다.

### 절차

1. **가입**: [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/)에서 개인(Individual)으로
   가입하고 결제합니다. 승인까지 시간이 걸릴 수 있습니다.

2. **인증서 서명 요청(CSR) 만들기** — Windows의 Git Bash에서:
   ```bash
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout developer_id.key -out developer_id.csr \
     -subj "/emailAddress=<Apple 계정 이메일>/CN=<영문 이름>/C=KR"
   ```
   `developer_id.key`는 개인키입니다. **절대 커밋하거나 공유하지 마세요.**

3. **인증서 발급**: [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/list) →
   **+** → **Developer ID Application** → 위의 `.csr` 업로드 → `.cer` 다운로드

4. **.p12로 변환** (GitHub Actions에 넣을 형태):
   ```bash
   openssl x509 -inform DER -in developerID_application.cer -out developer_id.pem
   openssl pkcs12 -export -legacy -inkey developer_id.key -in developer_id.pem -out developer_id.p12
   base64 -w0 developer_id.p12 > developer_id.p12.base64.txt
   ```
   `-export` 때 정한 비밀번호를 기억해 두세요. (`-legacy`는 macOS 키체인이 새 암호화 형식의 .p12를 못 읽는 문제를 피하기 위한 옵션입니다.)

5. **공증용 앱 암호**: [account.apple.com](https://account.apple.com) → 로그인 및 보안 → 앱 암호 → 새로 만들기.
   팀 ID는 [멤버십 페이지](https://developer.apple.com/account#MembershipDetailsCard)에서 확인합니다.

6. **GitHub Secrets 등록** (저장소 → Settings → Secrets and variables → Actions):

   | 이름 | 값 |
   |---|---|
   | `CSC_LINK` | `developer_id.p12.base64.txt`의 내용 |
   | `CSC_KEY_PASSWORD` | 4번에서 정한 .p12 비밀번호 |
   | `APPLE_ID` | Apple 계정 이메일 |
   | `APPLE_APP_SPECIFIC_PASSWORD` | 5번의 앱 암호 |
   | `APPLE_TEAM_ID` | 팀 ID |

### 이 저장소에서 바꿀 부분

1. `package.json`의 `build.mac`에서 `"sign": "./build/adhoc-sign.js"`를 지웁니다. electron-builder가 Developer ID
   인증서로 서명하고, 기본값인 hardened runtime과 기본 entitlements를 적용합니다. (`build/adhoc-sign.js` 파일도 삭제)
2. `.github/workflows/build.yml`의 macOS 빌드 단계에 위 Secrets를 환경변수로 넘깁니다. electron-builder는 `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`가 있으면 빌드 중에 자동으로 공증합니다.
3. **자동 업데이트 켜기**: `build.mac.target`에 `zip`을 추가하고(macOS 자동 업데이트는 zip을 씁니다), `build.mac`에도
   `publish` 설정을 넣어 `latest-mac.yml`이 생성되게 한 뒤, 워크플로가 `*.zip`과 `latest-mac.yml`도 릴리스에 올리게
   합니다. `updater.js`의 `usesElectronUpdater()`가 macOS에서도 `true`를 돌려주도록 바꾸면 Windows와 같은 흐름이 됩니다.
4. 이미 설치된 ad-hoc 서명 버전은 자동 업데이트로 서명 버전으로 넘어갈 수 없으므로(서명 검증 불가), 서명된 첫 버전은
   지금처럼 알림을 보고 직접 설치해야 합니다.

## 추천 순서

1. **Windows**: SignPath Foundation에 먼저 신청해 보세요. 무료이고, 심사를 기다리는 동안에도 지금 배포 방식에는 영향이 없습니다.
2. **macOS**: Mac 사용자가 늘어나 경고와 수동 업데이트가 불편하다는 피드백이 오면 Apple Developer Program 가입을 고려하세요.

서명 서비스나 인증서가 준비되면, 위의 "이 저장소에서 바꿀 부분"은 코드로 적용할 수 있습니다.

## 출처

- [SmartScreen reputation for Windows app developers (Microsoft Learn)](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Windows Apps PSA: EV Certs do not grant immediate reputation anymore (ToDesktop)](https://www.todesktop.com/blog/posts/windows-apps-psa-ev-certs-do-not-grant-immediate-reputation-anymore)
- [Understanding the New Code-Signing Certificate Validity Change (DigiCert)](https://www.digicert.com/blog/understanding-the-new-code-signing-certificate-validity-change)
- [SignPath Foundation conditions for Open Source projects](https://signpath.org/terms.html)
- [Certum Code Signing (Certum Shop)](https://shop.certum.eu/code-signing.html)
- [Artifact Signing FAQ (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
- [Artifact Signing pricing (Microsoft Azure)](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/)
- [Apple Developer Program enrollment](https://developer.apple.com/programs/enroll/)
- [Apple Developer Program – what's included (Korean)](https://developer.apple.com/kr/programs/whats-included/)
