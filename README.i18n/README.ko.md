# [IM.codes](https://im.codes)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

**AI 에이전트를 위한 IM.**

IM.codes는 AI 코딩 에이전트를 위한 전용 메신저입니다. iPhone, iPad, Apple Watch, 모바일이나 웹에서 장시간 실행 중인 agent session에 접근해 터미널, 파일 브라우징, Git 변경 보기, localhost 미리보기, 알림, 멀티 에이전트 워크플로를 사용할 수 있습니다. Claude Code, Codex, Gemini CLI, OpenClaw, Qwen을 지원합니다.

> 이 문서는 번역본입니다. **기준 문서는 영어 README(`../README.md`)입니다.** 차이가 있으면 영어판을 우선합니다.

Claude Code와 Codex는 이제 CLI와 SDK 두 방식 모두로 연결할 수 있습니다.

## 스크린샷

### 데스크톱

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-sidebar.png"><img src="../landing/imcodes-sidebar.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes0.png"><img src="../landing/imcodes0.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes1.png"><img src="../landing/imcodes1.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes2.png"><img src="../landing/imcodes2.png" width="24%" /></a>
</p>

### iPad / 태블릿

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad2.png"><img src="../landing/imcodes-ipad2.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad3.png"><img src="../landing/imcodes-ipad3.png" width="48%" /></a>
</p>

### 모바일

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m6.png"><img src="../landing/imcodes-m6.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m7.png"><img src="../landing/imcodes-m7.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m8.png"><img src="../landing/imcodes-m8.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m5.png"><img src="../landing/imcodes-m5.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m1.png"><img src="../landing/imcodes-m1.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m2.png"><img src="../landing/imcodes-m2.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m3.png"><img src="../landing/imcodes-m3.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m4.png"><img src="../landing/imcodes-m4.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m0.png"><img src="../landing/imcodes-m0.png" width="18%" /></a>
</p>

### Apple Watch

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch1.png"><img src="../landing/imcodes-watch1.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch0.png"><img src="../landing/imcodes-watch0.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch2.png"><img src="../landing/imcodes-watch2.png" width="31%" /></a>
</p>

Apple Watch에서는 세션 빠른 확인, 읽지 않음 개수, 푸시 알림, 빠른 답장을 지원합니다.

## 다운로드

<a href="https://apps.apple.com/us/app/im-codes/id6761014424"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40" alt="Download on the App Store" /></a>

iPhone, iPad, Apple Watch를 지원합니다. [Web App](https://app.im.codes) 과 `npm install -g imcodes` 기반 daemon CLI도 사용할 수 있습니다.

## 왜 필요한가

자리를 비우면 대부분의 coding-agent workflow가 끊깁니다. agent는 터미널에서 계속 실행되지만, 이어서 작업하려면 SSH, `tmux attach`, 원격 데스크톱 등이 필요합니다.

[IM.codes](https://im.codes)는 그런 session을 모바일과 웹에서 계속 다룰 수 있게 합니다. 터미널을 열고, 파일과 Git 변경을 보고, 다른 기기에서 localhost를 미리보고, 작업 완료 알림을 받고, 여러 agent를 계속 움직일 수 있습니다.

이것은 또 다른 AI IDE도 아니고 단순 원격 터미널도 아닙니다. 터미널 기반 coding agent 위에 놓이는 메시징 / 제어 레이어입니다.

## 주요 기능

### 원격 터미널
SSH, VPN, 포트 포워딩 없이 브라우저에서 agent session의 터미널에 접근할 수 있습니다.

### 파일 브라우저와 Git 변경 보기
프로젝트 트리, 업로드 / 다운로드, diff, 변경 요약을 제공합니다.

### 로컬 웹 프리뷰
배포 없이 로컬 개발 서버를 다른 기기에서 미리볼 수 있습니다.

### 모바일, 워치, 알림
생체 인증, 푸시 알림, shell session 입력, Apple Watch 빠른 응답을 지원합니다.

### 크로스 모델 감사와 P2P 토론
단일 모델의 출력을 맹목적으로 신뢰해서는 안 됩니다. P2P 토론은 서로 다른 프로바이더와 사고 방식을 가진 여러 agent가 코드 작성 전에 동일한 코드베이스에서 협력 분석을 수행합니다. 각 라운드는 커스터마이징 가능한 멀티 페이즈 파이프라인을 따르며, 각 agent는 이전 기여를 모두 읽은 후 출력합니다. 서로 다른 모델이 서로 다른 유형의 문제를 발견합니다. 이 크로스 프로바이더 교차 검토로 구현 전에 대부분의 문제를 찾아내어 재작업을 대폭 줄일 수 있습니다.

내장 모드는 `audit`(구조화된 audit → review → plan 파이프라인), `review`, `discuss`, `brainstorm`이며, 사용자 정의 페이즈 구성도 가능합니다. Claude Code, Codex, Gemini CLI, Qwen에서 작동합니다.

### 스트리밍 Transport Agents
OpenClaw, Qwen 같은 transport agent에 대해 네이티브 스트리밍을 제공합니다.

### 에이전트 간 통신
`imcodes send`로 한 agent가 다른 agent에게 직접 리뷰나 테스트를 요청할 수 있습니다.

```bash
imcodes send "Plan" "review the changes in src/api.ts"
imcodes send "Cx" "run tests" --reply
imcodes send --all "migration complete, check your end"
```

```python
# monitor.py — watch a log file, trigger agent when errors appear
import subprocess, time

while True:
    with open("/var/log/app.log") as f:
        for line in f:
            if "ERROR" in line:
                subprocess.run([
                    "imcodes", "send", "Claude",
                    f"Fix this error and write the patch to /tmp/fix.patch:\n{line}"
                ])
    time.sleep(30)
```

```bash
# Webhook → agent: GitHub webhook handler triggers code review
curl -X POST https://your-server/webhook -d '{"pr": 42}' \
  && imcodes send "Gemini" "review PR #42, write summary to /tmp/review.md"

# CI → agent: post-build trigger
imcodes send "Claude" "tests failed on main, check CI log at /tmp/ci.log and fix" --reply
```

### 스마트 `@` 선택기
`@`는 프로젝트 파일 검색, `@@`는 P2P 대상 agent 선택에 사용됩니다.

### 다중 서버 / 다중 세션 관리
여러 개발 머신을 하나의 대시보드에 연결할 수 있습니다.

### Discord 스타일 사이드바
서버 전환, 계층형 session 트리, 읽지 않음 배지, 고정 패널을 제공합니다.

### 고정 패널
파일 브라우저, 저장소 페이지, sub-session 채팅, 터미널을 사이드바에 고정할 수 있습니다.

### 저장소 대시보드
이슈, PR, 브랜치, 커밋, CI/CD 실행 상태를 앱 안에서 확인할 수 있습니다.

### 예약 작업 (Cron)
cron 스타일로 반복적인 agent workflow를 자동화할 수 있습니다.

### 기기 간 동기화
탭 순서와 고정 패널이 서버 설정 API를 통해 동기화됩니다.

### 국제화
UI는 7개 언어를 지원합니다.

### OTA 업데이트
daemon은 npm으로 자체 업그레이드할 수 있고, 웹에서도 트리거할 수 있습니다.

## IM.codes가 아닌 것

- 또 다른 AI IDE가 아님
- 단순 채팅 래퍼가 아님
- 단순 원격 터미널 클라이언트가 아님
- Claude Code, Codex, Gemini CLI, OpenClaw, Qwen의 대체품이 아님
- 그 위에 놓이는 메시징 / 제어 레이어임

## 아키텍처

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted)
        ↓ WebSocket
Daemon (your machine)
        ↓ tmux / transport
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

daemon은 개발 머신에서 실행되며 tmux 또는 transport 프로토콜을 통해 session을 관리합니다. 서버는 각 기기와 daemon 사이를 중계합니다. 데이터는 자신의 인프라 안에 남습니다.

## 설치

```bash
npm install -g imcodes
```

## 빠른 시작

> **Self-host를 강하게 권장합니다.** 공유 인스턴스 `app.im.codes`는 테스트 용도입니다.

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

이 명령은 머신을 바인드하고, daemon을 시작하고, 시스템 서비스로 등록한 뒤, 웹 / 모바일 대시보드에 해당 머신을 표시합니다.

### OpenClaw 연결

OpenClaw가 로컬에서 실행 중이라면 daemon 머신에서 IM.codes를 OpenClaw gateway에 연결할 수 있습니다.

```bash
imcodes connect openclaw
```

이 명령은 다음을 수행합니다.

- 기본적으로 `ws://127.0.0.1:18789`에 연결
- `~/.openclaw/openclaw.json`의 token 자동 재사용
- OpenClaw의 main / child session을 IM.codes에 동기화
- `~/.imcodes/openclaw.json`에 설정 저장
- daemon을 재시작해 자동 재연결 가능하게 함

```bash
imcodes connect openclaw --url ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=... imcodes connect openclaw
imcodes connect openclaw --url wss://gateway.example.com
```

참고:

- TLS 없는 원격 `ws://`는 `--insecure`가 필요
- `imcodes disconnect openclaw`로 저장된 설정 삭제 및 연결 해제 가능
- 현재 이 흐름은 macOS에서만 테스트됨

## Self-Host

### 원커맨드 설정

```bash
npm install -g imcodes
mkdir imcodes && cd imcodes
imcodes setup --domain imc.example.com
```

### 수동 설정

```bash
git clone https://github.com/im4codes/imcodes.git && cd imcodes
./gen-env.sh imc.example.com        # generates .env with random secrets, prints admin password
docker compose up -d
```

## Windows (실험적)

```cmd
npm install -g imcodes
imcodes bind https://app.im.codes/bind/<api-key>
```

```cmd
imcodes upgrade
```

```cmd
imcodes repair-watchdog
```

```cmd
npm prefix -g
```

```cmd
setx PATH "<npm-prefix-path>;%PATH%"
```

```
%USERPROFILE%\.imcodes\watchdog.log
```

## 요구 사항

- macOS 또는 Linux
- Windows (실험적, ConPTY 사용)
- Node.js >= 22
- Linux / macOS에서는 tmux
- Claude Code, Codex, Gemini CLI, OpenClaw, Qwen 중 하나

## 고지 사항

IM.codes는 독립적인 오픈소스 프로젝트이며 Anthropic, OpenAI, Google, Alibaba, OpenClaw 등과 제휴, 보증, 후원 관계가 없습니다.

## 라이선스

[MIT](../LICENSE)

© 2026 [IM.codes](https://im.codes)
