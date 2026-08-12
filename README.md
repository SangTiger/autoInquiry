# autoIquiary — 문의폼 자동 작성기

임의 사이트의 문의폼을 `profile.json` 하나로 자동 채운다. 좌표 매크로가 아니라 셀렉터 기반이므로 레이아웃이 바뀌어도 동작한다.

## 사용법

```bash
node fill.mjs --url <URL>          # 단일 사이트 dry-run
node fill.mjs --all                # targets.json 전체 dry-run
node fill.mjs --url <URL> --submit # 실제 전송
node fill.mjs --all --submit       # 전체 실제 전송
```

| 옵션 | 설명 |
|---|---|
| `--headless` | 창 없이 실행 (기본: 창 띄움) |
| `--json` | 결과를 JSON으로 출력 |
| `--force` | `out/log.csv`에 이미 `sent`된 URL도 재처리 |

기본은 dry-run. 채우고 스크린샷만 남기고 멈춘다. 실제 전송은 `--submit` 명시 시에만.

종료 코드: 전부 정상 `0`, 스킵·실패 하나라도 있으면 `1`.

## 설정 파일

### `profile.json` — 발신자 정보

```json
{
  "company": "포인테일",
  "name": "박상범",
  "phone": "010-0000-0000",
  "email": "you@example.com",
  "url": "https://pointail.jp",
  "subject": "제목",
  "inquiryTypePriority": ["대행사 협업", "협업 문의", "기타"],
  "sourcePriority": ["검색", "기타"],
  "locationPriority": ["한국"],
  "agreeRequired": true,
  "agreeMarketing": false,
  "message": "본문... {{suffix}}"
}
```

`inquiryTypePriority` / `sourcePriority` / `locationPriority`는 우선순위 배열 — 위에서부터 부분일치하는 첫 옵션을 선택. `{{suffix}}`에 사이트별 `messageSuffix`가 삽입된다.

### `targets.json` — 대상 목록

```json
{
  "targets": [
    {
      "url": "https://example.co.kr/inquiry",
      "messageSuffix": "사이트별 1~2문장.",
      "formIndex": 1,
      "overrides": { "company": "#corp_name" },
      "answers": { "캠페인 날짜": "미정" },
      "checkConsents": ["네, 동의합니다."],
      "_skip": true
    }
  ]
}
```

| 키 | 용도 |
|---|---|
| `messageSuffix` | 본문 `{{suffix}}` 자리 삽입 문장 (사이트마다 다르게 해야 스팸 방지) |
| `formIndex` | 폼이 여러 개일 때 직접 지정 (로그의 `폼 후보 N개` 경고 참고) |
| `overrides` | 자동 매핑이 못 잡는 칸만 셀렉터 직접 지정 |
| `answers` | 프로필에 없는 사이트 고유 필수 항목 (`{ "라벨": "답변" }`) |
| `checkConsents` | 자동 분류가 안 되는 동의·선택 체크박스 라벨 지정 |
| `_skip` | 해당 사이트 건너뜀 (캡차·폼없음 등) |

## 엔진 구성

### `fill.mjs` — 실행 진입점
- CLI 파싱 · Playwright 브라우저 제어 · 스크린샷 · `out/log.csv` 기록 · 제출 게이트
- 페이지 로드 후 맨 아래까지 스크롤 → AOS/IntersectionObserver로 지연 렌더되는 폼 트리거
- `pickBestContext` 이후 상단 복귀 (Elementor 등은 뷰포트 밖이면 다시 hidden 처리됨)

### `lib/inspect.mjs` — DOM → 필드 인벤토리
- 모든 input/textarea/select/button을 수집해 `kind`·`label`·`required` 등 메타 추출
- **폼 그룹 분리**: 한 페이지에 섞인 문의폼·검색폼·뉴스레터를 `<form>` 단위 또는 제출버튼 기준 블록 단위로 분리. 점수 최고 그룹 1개만 선택
- **프레임 탐색**: 메인 프레임 + 자식 iframe 전부 검사 후 unresolved 최소 컨텍스트 선택
- **라벨 추론**: `label[for]` 없는 커스텀 폼은 바로 앞 텍스트 노드를 라벨로 추정
- **필수 표시 감지**: `required` 속성 + `*` 텍스트 + CSS `::after`/`::before` content까지 검사
- **커스텀 체크박스 허용**: `label[for]` 또는 조상 `<label>`이 있으면 CSS 숨김 체크박스도 통과
- **`submitish()`**: `input[type=submit|button]`은 텍스트 패턴 없이 무조건 제출 버튼으로 인식

### `lib/map.mjs` — 인벤토리 → 매핑 계획
- 키워드 사전(`KEYWORDS`) + 신호 점수(name/id/label/placeholder/nearby) → 프로필 키 결정
- 타입 힌트(`input[type=email|url]`, `textarea`)가 가장 강한 신호
- **담당자명 중의성 해소**: name 후보 문자열에 phone/email 키워드가 섞이면 0점 처리
- **연락처 분할 지원**: `010 / 1234 / 5678` 3칸 구조 감지 및 자동 배분
- **다중선택 그룹 체크박스**: 같은 `name` 속성 공유 체크박스가 2개 이상이면 서비스 선택 그룹으로 판단 → 필수여도 unresolved 대신 경고 처리. `checkConsents`로 특정 항목만 선택 가능
- **동의 분류 원칙**: `checkConsents` → `[필수]`/`required` 표기 → `개인정보`/`약관` 문구 순서로만 자동 체크. 그 외는 손대지 않고 경고
- **필수 미해결 시 전체 스킵**: 매핑 못 한 필수 칸이 하나라도 있으면 그 사이트 제출 안 함

### `lib/act.mjs` — 계획 → 실제 입력 + 검증
- `input[type=number]`: Playwright `fill()`이 하이픈 등 비숫자를 거부 → 숫자만 추출 후 채우고, 숫자가 없으면 `evaluate()`로 직접 설정
- **체크박스 5단 폴백**: `setChecked` → `label[for]` 클릭 → 조상 `<label>` 클릭 → force click → DOM native click. `el.checked = v` 직접 대입은 쓰지 않음 (React 상태 desync)
- **커스텀 체크박스 waitFor**: `visible` 대신 `attached` (CSS 숨김이라 visible 상태가 안 됨)
- 입력 후 페이지에서 값을 **다시 읽어 검증** (연락처는 숫자만 비교)

## 산출물

```
out/
├── shots/{host}-{ts}-before.png   # 채운 직후 (dry-run은 여기까지)
├── shots/{host}-{ts}-after.png    # 제출 후 (--submit 시에만)
└── log.csv                        # ts, url, status, mapped, unresolved, http, shots
```

`status`: `dry` · `sent` · `skipped` · `failed`

## 수동 처리 대상

| 사이트 | 사유 |
|---|---|
| bestswit.com | 폼 없음 → info@bestswit.com 직접 발송 |
| firstpageup.com | Cloudflare Turnstile 캡차 |
| interad.com | Cloudflare Turnstile 캡차 |
| gyseoul.co.kr | NinjaFirewall WAF → `--headless` 없이 실행 필요 |
