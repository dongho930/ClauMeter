# 클로미터 프록시 서버

클로미터(ClauMeter) 앱의 "AI 사용량 페이스 조언" 기능이 Groq API를 직접 호출하지 않고 이 서버를 거치게 합니다.
Groq API 키는 이 서버(Vercel 환경변수)에만 존재하며, 배포되는 앱 안에는 절대 포함되지 않습니다.

## 배포 (Vercel)

1. [Groq 콘솔](https://console.groq.com/keys)에서 API 키를 발급받습니다.
2. 이 `proxy-server` 폴더를 Vercel 프로젝트로 배포합니다.
   ```
   cd proxy-server
   npx vercel login
   npx vercel --prod
   ```
   처음 배포할 때 프로젝트 이름을 정하게 되는데, 그 이름이 `https://<이름>.vercel.app` 주소가 됩니다.
3. Vercel 대시보드 → 해당 프로젝트 → Settings → Environment Variables에서:
   - `GROQ_API_KEY` = 발급받은 Groq 키 (필수)
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` = [Upstash](https://upstash.com) 무료 Redis에서 발급 (선택, 요청 제한용 - 사용자가 많아지면 비용 폭탄을 막기 위해 등록을 권장합니다)
4. 환경변수를 추가한 뒤 한 번 재배포합니다 (`npx vercel --prod`).
5. 배포된 주소(`https://<이름>.vercel.app/api/advice`)를 확인하고, 이 값을 `main.js`의 `PROXY_URL` 상수에 넣습니다.

## 엔드포인트

`POST /api/advice`

```json
{ "prompt": "..." }
```

응답:
```json
{ "text": "Groq가 생성한 원문 텍스트" }
```

모델·온도·최대 토큰 수는 전부 서버에서 고정되어 있으며, 클라이언트가 보낸 값은 무시됩니다.
요청 본문(prompt)이 너무 길면(4000자 초과) 거부됩니다.

## 비용에 대해

이 서버가 처리하는 모든 요청은 서버 운영자(여러분)의 Groq 요금으로 청구됩니다. 배포 규모가 커질 것 같다면
`UPSTASH_REDIS_REST_URL`/`TOKEN`을 반드시 설정해서 IP당 요청 제한(기본: 시간당 20회, `api/advice.js`의
`Ratelimit.slidingWindow(20, '1 h')`에서 조정 가능)을 켜두세요.
