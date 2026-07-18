# [IM.codes](https://im.codes)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

**에이전트를 위한 IM. 공유 메모리, OpenSpec Auto Deliver, 관리형 MCP 도구, 감독된 실행, 사람 간 협업, 그리고 AI 제공자 전반의 교차 감사.**

<!-- TODO(native-review): KO hero couplet — 第一句「백지장도 맞들면 낫다」承接弱,待母语者重写;默认「천하」 -->
> 백지장도 맞들면 낫다.<br>
> 허나 세 명의 제갈량, 담소 속에 천하를 정한다.<br>
> — IM.codes

IM.codes는 coding agent를 위한, provider를 가로지르는 공유 메모리 레이어이자 관리형 MCP tool surface입니다. 완료된 작업을 재사용 가능한 컨텍스트로 축적하고, 적절한 기록을 이후 session에 주입하거나 recall합니다. Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor, OpenCode, OpenClaw, Qwen 등을 지원하며, 터미널, 파일 브라우징, Git 보기, localhost 미리보기, 알림, 멀티 에이전트 워크플로우, transport 기반 agent의 네이티브 스트리밍 출력도 함께 제공합니다. OpenSpec Auto Deliver는 변경을 proposal/spec 감사부터 구현, 검증 힌트, Team 감사/재작업, 자동 모듈 채점, 최종 quality gate까지 진행할 수 있습니다. 세션 공유도 live agent session 중심의 pair 또는 multi-person 협업 코딩을 지원합니다. 내장된 Auto supervision은 완료된 턴을 판정하고, 자동 계속과 감사/재작업 루프까지 수행한 뒤 제어를 돌려줄 수 있습니다. Team 토론 기능 내장 — 여러 모델이 서로의 계획과 구현을 리뷰하고 감사하여, 단일 모델의 누락·맹점·편향을 효과적으로 줄입니다.

> 이 문서는 번역본입니다. **기준 문서는 영어 README(`../README.md`)입니다.** 차이가 있으면 영어판을 우선합니다.

여러 에이전트가 CLI와 SDK 두 방식 모두로 연결될 수 있습니다.

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

iPhone, iPad, Apple Watch를 지원합니다. [Web App](https://app.im.codes) 도 사용할 수 있습니다.

## 왜 필요한가

자리를 비우면 대부분의 coding-agent workflow가 끊깁니다. agent는 터미널에서 계속 실행되지만, 이어서 작업하려면 SSH, `tmux attach`, 원격 데스크톱 등이 필요합니다.

그것은 문제의 절반일 뿐입니다. 복잡한 coding-agent 작업에는 더 안정적인 판단도 필요합니다. 단일 모델은 익숙한 패턴에 갇히거나 문제를 놓치고, 어려운 작업에서 출력이 불안정해질 수 있습니다. provider를 바꾸면 새로운 관점은 얻을 수 있지만, 공유 컨텍스트가 없으면 흐름과 프로젝트 메모리도 잃기 쉽습니다.

[IM.codes](https://im.codes)는 이 두 가지 요구를 함께 다룹니다. 그런 session을 모바일과 웹에서 계속 다룰 수 있게 하며, 터미널을 열고, 파일과 Git 변경을 보고, 다른 기기에서 localhost를 미리보고, 작업 완료 알림을 받고, 다른 사람을 같은 session이나 server에 초대하며, 여러 agent를 계속 움직일 수 있습니다. 또한 아래의 "Shared Agent Context와 메모리"와 "크로스 모델 감사와 Team 토론"을 연결합니다. 지속적인 recall은 완료된 작업의 요약 메모리에서 오고, Team 토론은 코드가 반영되기 전의 구조화된 크로스 모델 리뷰입니다. 출력을 완벽하게 만들지는 않지만 단일 모델의 맹점을 줄이고, 복잡한 작업이 더 많은 리뷰 속에서 수렴하기 쉽게 합니다.

이것은 또 다른 AI IDE도 아니고 단순 원격 터미널도 아닙니다. 터미널 기반 coding agent 위에 놓이는 메시징, 메모리, 리뷰 레이어입니다.

## OpenSpec Auto Deliver

OpenSpec 기반 변경에서 Auto Deliver는 change folder를 end-to-end 감독형 delivery run으로 바꿉니다: proposal/spec review, 구현, 검증, Team audit, 자동 모듈 채점, rework gate, 보이는 최종 handoff까지 처리합니다.

- **원클릭 change pipeline.** transport-backed coding session에서 시작합니다. IM.codes는 owning session을 해석하고, 충돌 실행을 막기 위해 Team lane을 잠그고, `tasks.md`를 읽고, UI에 live run projection을 유지합니다.
- **구현 전 spec audit.** 선택적 proposal/spec audit-repair는 일반 Team flow(기본 `audit>review>plan`)를 사용하며 chat summary가 아니라 authoritative JSON을 읽습니다.
- **Task-driven 구현 루프.** daemon은 같은 session에 focused implementation prompt를 보내고, 해당 OpenSpec change만 다루며, checked/unchecked tasks를 추적하고, project manifests에서 발견한 안전한 validation command 후보를 표시합니다.
- **자동 모듈 채점.** 각 audit은 `spec`, `tasks`, `implementation`, `tests`, `risk`에 대한 structured scores를 만들고, evidence와 summary는 run details에 표시됩니다.
- **구현 audit과 rework gate.** 점수가 포함된 final verdict — `PASS`, `REWORK`, `BLOCKED` — 가 pass, 제한 내 repair, 또는 human decision 필요 여부를 결정합니다.
- **Fail-closed와 사람의 최종 통제.** 잘못된 audit output, 시간/횟수 제한, manual interference, 호환되지 않는 Team state, 읽을 수 없는 tasks에서는 human input을 요청합니다. code를 stage, commit, push하지 않습니다.

## 협업 코딩

현재 탭, sub-session, 또는 전체 source server를 다른 사용자에게 공유할 수 있습니다. `viewer`는 read-only review에, `participant`는 covered session에 prompt를 보낼 때 사용합니다. Shared message에는 actor label이 붙고 access는 UI에서 낮추거나 회수할 수 있습니다.

## Shared Agent Context와 메모리

IM.codes는 완료된 에이전트 작업을 계속 재사용 가능한 메모리로 축적하고, 그 컨텍스트를 이후 세션에 다시 주입합니다.

- **저장되는 것은 문제 → 해결 요약이지 로그 잡음이 아닙니다.** 메모리화되는 것은 최종 `assistant.text` 뿐이며, 스트리밍 delta, tool call, tool result, 중간 잡음은 제외됩니다.
- **개인 메모리는 선택적으로 클라우드 동기화할 수 있습니다.** 원본과 처리된 메모리는 항상 로컬에 남고, 처리된 요약만 사용자 단위 클라우드 풀에 동기화해 여러 기기에서 공유할 수 있습니다.
- **Enterprise Shared Context는 검색하고 확인할 수 있습니다.** 팀은 지식을 workspace / project 범위에 게시하고 UI에서 검색과 통계를 볼 수 있으므로, 보이지 않는 prompt 문자열로만 남지 않습니다. 이 부분은 아직 계속 개발 중이며 완전한 프로덕션 테스트는 끝나지 않았습니다.
- **다국어 리콜.** 로컬 의미 검색과 pgvector 기반 서버 리콜이 다국어 embedding을 사용하므로 한국어, 영어, 중국어, 일본어, 스페인어, 러시아어 사이에서도 관련 수정 이력을 찾을 수 있습니다.
- **메시지 전송 시와 세션 시작 시 자동 주입.** 관련 기록은 전송 전과 시작 시점 모두에서 자동 주입되며, timeline 카드에 주입 이유, 관련성 점수, 재사용 횟수, 마지막 사용 시각까지 표시됩니다.
- **사용자가 보고 제어할 수 있습니다.** Shared Context UI는 raw events, processed summaries, cloud memory, enterprise memory를 분리해 보여주고, 검색, 미리보기, archive/restore, 처리 설정을 제공합니다.

## 관리형 MCP 도구

IM.codes는 지원되는 SDK형 provider에 daemon이 관리하는 stdio MCP server를 노출합니다. Agent는 같은 runtime scope 안에서 memory, agent-to-agent messaging, scheduled follow-up을 처리할 수 있으며 raw auth token이나 ad hoc shell command를 다룰 필요가 없습니다.

- **메모리 검색과 provenance.** `search_memory`는 caller-bound memory namespace에서 과거 작업, project history, decisions, preferences, bugs, commits, deployments, 이전 논의 컨텍스트를 검색합니다. `list_memory_summaries`는 query 없이 recent compact summaries를 가져옵니다. 결과에는 compact refs와 `projectionId`가 포함됩니다. 정확한 과거 지시, bug detail, commit/deployment context, source evidence가 필요할 때 `get_memory_sources`가 관련 hit를 provenance snippets로 확장합니다.
- **메모리 쓰기.** `save_observation`은 유용한 사실, 결정, 구현 메모를 user-private memory candidate로 저장합니다. `save_preference`는 안정적인 사용자 preference를 명시적 preference path로 저장합니다.
- **Agent messaging.** `send_list_targets`는 현재 project 안의 sibling sessions를 나열하고, `send_message`는 같은 guarded `imcodes send` pipeline으로 scoped message, optional file path reference, reply request, broadcast를 보냅니다.
- **Cron scheduling.** `cron_create`, `cron_list`, `cron_update`, `cron_delete`는 reminder, recurring check, delegated review, scheduled Team follow-up을 위한 future structured sends를 관리하며 target/session/project, expiration, timezone fields를 다룰 수 있습니다.
- **Runtime-bound identity와 안전성.** Tool call은 runtime에서 현재 IM.codes session, project, user, server에 바인딩됩니다. Agent는 namespace, user, server, token, routing fields를 위조할 수 없습니다. Memory, Send, Cron은 underlying feature gates와 MCP kill-switch 모두로 보호됩니다.
- **운영 가시성.** Shared Context UI는 provider별 MCP readiness, tool-family gate, degraded reason, update time, daemon-redacted recent tool calls를 표시해 해당 model이 실제로 Memory, Send, Cron을 사용할 수 있는지 확인하게 해줍니다.

## 감독된 실행과 Auto Audit

IM.codes는 직접 작성한 supervisor 지시문으로 지원되는 agent session을 턴 단위로 주행할 수 있습니다 —— 각 완료된 턴을 idle 경계에서 구조적으로 판정해 auto-continue, 제어 반환, 또는 audit 루프 발동을 결정하며, 매 라운드마다 "continue"를 직접 입력할 필요가 없습니다.

- **세션별 Auto 모드.** `off`, `supervised`, `supervised_audit`를 세션마다 설정할 수 있어 하나의 정책을 전체에 강제하지 않습니다.
- **idle 경계에서의 완료 판정.** 한 턴이 끝나면 IM.codes가 `complete`, `continue`, `ask_human`을 판정하고, 다음 continue prompt를 같은 session에 다시 보낼 수 있습니다.
- **fail-closed 자동화.** Auto supervision은 timeline/footer에 보이는 상태로 남고, 구조화된 결정을 사용하며, timeout·잘못된 출력·설정 오류가 있으면 추측하지 않고 사용자에게 제어를 돌려줍니다.
- **선택적 audit → rework 루프.** `supervised_audit`에서는 완료된 턴을 자동 감사 파이프라인으로 보내고, 필요하면 같은 session에 재작업 brief를 넣은 뒤 제어를 돌려줄 수 있습니다.
- **전역 기본값 + 세션별 override.** 기본 supervisor backend/model/timeout을 한 번 정해 두고, 필요할 때 각 session에서 backend/model/timeout, audit 모드, custom instructions를 덮어쓸 수 있습니다.
- **실제 IM.codes workflow를 이해.** Auto supervision은 OpenSpec 작업, Team 토론/리뷰 흐름, `imcodes send` 기반 에이전트 간 조정을 사람에게 즉시 넘겨야 하는 이유가 아니라, 에이전트가 계속 수행할 수 있는 정상적인 다음 단계로 해석합니다。

## 주요 기능

### 비공개 별칭

사용자 소유의 재사용 가능한 텍스트 조각을 저장하고 composer에서 `;`를 입력해 검색하거나 `;;(name)` 마커를 직접 삽입할 수 있습니다. 메시지에는 마커가 그대로 보이고 IM.codes가 값을 대역 외로 해석해 agent에 전달합니다. Agent도 managed MCP tools로 별칭을 생성·검색·편집·해석할 수 있습니다. 일괄 목록은 메타데이터만 공개하므로 한 번의 호출로 모든 값이 모델 컨텍스트에 들어가지 않습니다.

### 제어 노드

다른 머신을 완전한 IM.codes source server로 만들지 않고 제한된 controlled node로 등록할 수 있습니다. `^`로 대상을 자동 완성하거나 `^^(name)`을 직접 삽입하면, 권한을 받은 agent가 해당 노드에서 범위가 지정된 원격 명령, 단일 파일 전송, 타입이 지정된 Computer Use tool을 실행할 수 있습니다. 실행 권한은 소유자가 활성화하거나 철회할 수 있고, controlled node는 일반 server/session 목록에 섞이지 않으며 머신마다 독립 자격 증명을 사용합니다. 다운로드 링크는 만료되지만 새로 받은 설치 패키지는 보관해 여러 머신 등록에 재사용할 수 있습니다.

### Computer Use 및 브라우저 자동화

지원되는 SDK agent는 타입이 지정된 Computer Use tool로 데스크톱 앱을 제어할 수 있습니다. 크로스플랫폼 데스크톱 앱 제어에는 Leo([iFurySt](https://github.com/iFurySt))가 개발하고 MIT 라이선스로 배포한 [Open Computer Use](https://github.com/iFurySt/open-codex-computer-use)를 통합했으며, 이 통합 기능에 대해 해당 프로젝트에 명확히 크레딧을 표합니다.

브라우저 자동화는 별도로 IM.codes가 구현한 Chrome DevTools Protocol(CDP) 기반 기능입니다. 페이지 열기, 검사, 이동, 클릭, 입력 및 스크립트 평가를 지원하고 기본적으로 구조화된 텍스트를 반환하며 요청할 때만 스크린샷을 첨부합니다. 관리 브라우저는 로컬 루프백 전용 CDP endpoint도 노출하므로 로컬 Python 또는 Node script가 같은 실행 중인 browser instance를 재사용할 수 있습니다.

### 원격 터미널
SSH, VPN, 포트 포워딩 없이 브라우저에서 agent session의 터미널에 접근할 수 있습니다.

### 파일 브라우저와 Git 변경 보기
프로젝트 트리, 업로드 / 다운로드, diff, 변경 요약, 안전한 HTML 빠른 미리보기를 제공합니다. 채팅의 로컬 이미지 링크는 인라인으로 표시되고 클릭하면 플로팅 확대 보기로 열립니다.

### 로컬 웹 프리뷰
배포 없이 로컬 개발 서버를 다른 기기에서 미리볼 수 있습니다.

### 모바일, 워치, 알림
생체 인증, 푸시 알림, shell session 입력, Apple Watch 빠른 응답을 지원합니다.

### OpenSpec Auto Deliver
Spec-driven change를 구조화된 pipeline으로 진행합니다: proposal/spec audit, implementation prompts, manifest-aware validation hints, Team audit/rework, spec/tasks/implementation/tests/risk 자동 채점, fail-closed handoff.

### 협업 코딩
Live session을 다른 사람에게 공유해 pair programming을 하거나, viewer/participant roles로 scoped server workspace에 여러 사람을 초대할 수 있습니다.

### 크로스 모델 감사와 Team 토론
단일 모델의 출력을 맹목적으로 신뢰해서는 안 됩니다. Team 토론은 서로 다른 프로바이더와 사고 방식을 가진 여러 agent가 코드 작성 전에 동일한 코드베이스에서 협력 분석을 수행합니다. 각 라운드는 커스터마이징 가능한 멀티 페이즈 파이프라인을 따르며, 각 agent는 이전 기여를 모두 읽은 후 출력합니다. 서로 다른 모델이 서로 다른 유형의 문제를 발견합니다. 이 크로스 프로바이더 교차 검토로 구현 전에 단일 모델이 자주 놓치는 문제를 찾아내어 재작업을 줄일 수 있습니다.

내장 모드는 `audit`(구조화된 audit → review → plan 파이프라인), `review`, `discuss`, `brainstorm`이며, 사용자 정의 페이즈 구성도 가능합니다. Claude Code, Codex, Gemini CLI, Qwen에서 작동합니다.

### 스트리밍 Transport Agents
OpenClaw, Qwen 같은 transport agent에 대해 네이티브 스트리밍을 제공합니다.

### 관리형 MCP 도구면
지원되는 SDK provider는 IM.codes 관리형 10-tool MCP surface를 자동으로 받을 수 있습니다. memory search/source lookup, observation/preference capture, scoped Send, Cron scheduling을 포함합니다. UI에는 provider별 ready/degraded state가 표시되어 Memory, Send, Cron이 해당 model에서 실제로 사용 가능한지 알 수 있습니다.

### 에이전트 간 통신
`imcodes send`로 한 agent가 다른 agent에게 직접 리뷰나 테스트를 요청할 수 있습니다.

같은 flow는 MCP를 통해 SDK형 agent에도 제공됩니다. `send_list_targets`가 유효한 sibling target을 찾고, `send_message`가 scoped text, file references, reply requests, broadcasts를 보냅니다. raw routing credential은 노출되지 않습니다.

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
`@`는 프로젝트 파일 검색, `@@`는 Team 대상 agent 선택에 사용됩니다.

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

SDK형 agent도 MCP를 통해 같은 scheduler를 조작할 수 있습니다. `cron_create`, `cron_list`, `cron_update`, `cron_delete`로 reminder, recurring check, delegated review, follow-up용 structured send를 만들 수 있으며 현재 project/session identity에 바인딩된 상태로 동작합니다.

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
        ↓ tmux / transport / managed MCP
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

daemon은 개발 머신에서 실행되며 tmux 기반 process-backed sessions와 SDK / network protocols 기반 transport-backed sessions를 관리합니다. 또한 지원되는 SDK provider에 runtime-scoped Memory, Send, Cron tools를 노출하는 managed MCP server도 소유합니다. 서버는 각 기기와 daemon 사이를 중계합니다. 데이터는 자신의 인프라 안에 남습니다.

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

생성되는 `docker-compose.yml` 은 PostgreSQL 이미지로 `pgvector/pgvector:pg18` 을 사용합니다.

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

## 프로젝트 정보

개인 프로젝트입니다. 제가 직접 작성한 코드는 거의 없으며, 대부분 [Claude Code](https://github.com/anthropics/claude-code)가 만들고 [Codex](https://github.com/openai/codex)와 [Gemini CLI](https://github.com/google-gemini/gemini-cli)도 중요한 기여를 했습니다.

## 고지 사항

IM.codes는 독립적인 오픈소스 프로젝트이며 Anthropic, OpenAI, Google, Alibaba, OpenClaw 등과 제휴, 보증, 후원 관계가 없습니다.

## 라이선스

[MIT](../LICENSE)

© 2026 [IM.codes](https://im.codes)
