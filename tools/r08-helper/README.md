# R08 사람 쪽 helper

자기 기기에서 직접 돌리는 Claude Code·Codex 세션이 턴을 끝냈을 때 봇이 Discord로 알리게 합니다. 봇은 이 신호로 모델을 부르거나 작업을 시작·취소·재개하지 않고, 결과를 확인하지도 않습니다. 사람 세션의 자기 보고입니다.

**수신 경로는 tailnet 전용입니다.** helper는 `https://<서비스명>.<tailnet>.ts.net/external-task-events`로만 보냅니다. 인터넷 공개 주소는 없어서 보내는 기기마다 Tailscale에 로그인되어 있어야 합니다. 봇 스위치(`EXTERNAL_TASK_EVENTS_ENABLED`)가 꺼져 있으면 `/attach` 명령이 없고, 그 전에는 아래 3단계부터 진행할 수 없습니다.

## 무엇이 어디로 가나

- 보내는 값: 등록한 세션 ID, `turn_complete`, 발생 시각, 요약, 이벤트 ID, 연결 ID.
- 요약 기본값은 고정 문구 `턴 완료`입니다. 대화 내용은 나가지 않습니다.
- 내용 요약은 봇의 연결과 helper 설정 **양쪽에서** 동의한 연결만 씁니다. 최대 500자로 자르고, 경로·토큰·긴 인코딩 문자열이 의심되면 고정 문구로 바꿉니다. 이 걸러내기는 완전하지 않아서 비밀이 빠져나갈 수 있습니다.
- `cwd`, `transcript_path`, 입력 메시지, 답 전문, 도구 출력은 보내지도 파일에 남기지도 않습니다.

## 설치

필요한 것: Node 20 이상, Tailscale(로그인된 상태, 봇 수신 주소에 ACL로 허용된 기기), 비밀 저장소(macOS Keychain의 `security` 또는 Linux libsecret의 `secret-tool`).

1. 이 디렉터리를 기기로 복사합니다. 다른 의존성은 없습니다. 아래에서 `<helper>`는 복사한 절대 경로입니다.

2. 연결할 세션의 ID를 확인합니다. Claude는 Stop 입력의 `session_id`, Codex는 notify 입력의 `thread-id`와 같은 값입니다. 다른 세션은 큐에 들어가지 않습니다.

3. 알림을 받을 대화 스레드에서 `/attach`로 연결합니다. `target`은 세션 ID, `text`는 `claude` 또는 `codex`입니다. 내용 요약에 동의하면 `text`를 `claude summary=on`처럼 씁니다. 동의를 바꾸려면 해제하고 다시 연결합니다.

   응답은 본인에게만 보이고 **seed는 이때 한 번만** 나옵니다. 환경 식별자·연결 ID·키 ID도 같은 응답에 있습니다. 놓쳤다면 `/attach-list`로 연결 ID를 확인해 `/detach` 한 뒤 다시 `/attach` 하세요. 해제하면 이전 키는 즉시 무효가 되고, 아직 게시되지 않은 알림도 막힙니다. 봇이 응답을 전하지 못하면 그 키를 스스로 폐기하고 채널에 안내만 남깁니다.

4. seed를 비밀 저장소에 넣습니다. **명령 인자·셸 이력·설정 파일에 값을 쓰지 말고**, 아래처럼 프롬프트에 붙여 넣습니다.

   ```sh
   # macOS: -w를 맨 끝에 값 없이 두면 프롬프트로 묻습니다.
   security add-generic-password -U -s r08-helper -a <connection_id> -w

   # Linux
   secret-tool store --label="r08-helper" service r08-helper account <connection_id>
   ```

5. 설정 파일을 만듭니다. 위치는 `$XDG_CONFIG_HOME/r08-helper/config.json`(기본 `~/.config/r08-helper/config.json`)입니다. 프로젝트 안에 두지 마세요. 키 값은 넣지 않습니다. 모르는 키가 있으면 설정 전체를 거절합니다. 다른 사용자가 쓸 수 있는 권한이면 거절합니다.

   ```json
   {
     "version": 1,
     "endpoint": "https://<서비스명>.<tailnet>.ts.net/external-task-events",
     "environment": "<attach 응답의 environment>",
     "connections": [
       {
         "connection_id": "<연결 ID>",
         "key_id": "<키 ID>",
         "external_task_id": "<세션 ID>",
         "executor": "claude",
         "key_ref": "keychain:r08-helper:<connection_id>",
         "summary_consent": false
       }
     ]
   }
   ```

   `key_ref`는 `keychain:<서비스>:<계정>` 또는 `libsecret:<서비스>:<계정>`만 받습니다.

6. 훅을 사용자 설정에 연결합니다. 프로젝트 설정이 아니라 사용자 설정에 둡니다.

   Claude Code `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "Stop": [
         { "hooks": [ { "type": "command", "command": "node '<helper>/claude-stop.mjs'", "async": true } ] }
       ]
     }
   }
   ```

   Codex `~/.codex/config.toml`:

   ```toml
   notify = ["node", "<helper>/codex-notify.mjs"]
   ```

7. 전송기를 사용자 서비스로 띄웁니다. 훅은 큐에 넣기만 하므로 전송기가 없으면 아무것도 나가지 않습니다.

   macOS `~/Library/LaunchAgents/app.r08-helper.sender.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>app.r08-helper.sender</string>
     <key>ProgramArguments</key><array><string>/절대/경로/node</string><string><helper>/sender.mjs</string><string>run</string></array>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
   </dict></plist>
   ```

   ```sh
   launchctl load ~/Library/LaunchAgents/app.r08-helper.sender.plist
   ```

   Linux `~/.config/systemd/user/r08-helper-sender.service`:

   ```ini
   [Unit]
   Description=R08 helper sender

   [Service]
   ExecStart=/절대/경로/node <helper>/sender.mjs run
   Restart=always

   [Install]
   WantedBy=default.target
   ```

   ```sh
   systemctl --user enable --now r08-helper-sender
   ```

## 확인과 실패 표시

```sh
node <helper>/sender.mjs status
```

`queued`는 아직 못 보낸 수, `failures`는 사유별 실패 수입니다. 표시는 최근 1,000건까지 남고, 확인한 뒤 지우려면 큐 디렉터리의 `failures.jsonl`을 지웁니다.

| 사유 | 뜻 |
|---|---|
| `queue_full` | 기기 전체 100건 또는 1 MiB를 넘어 새 이벤트를 넣지 못함 |
| `expired` | 발생 후 24시간 안에 보내지 못함 |
| `rejected_401_unauthorized` | 서버가 거절. 폐기·만료·키 불일치. `/attach`로 다시 연결 필요 |
| `rejected_403_scope_denied` | 서버가 거절. 스레드가 꺼졌거나(`/stop`) owner 권한이 없음 |
| `rejected_403_summary_consent_required` | helper만 요약을 켰음. 봇 쪽 동의를 켜거나 helper의 `summary_consent`를 끄세요 |
| `key_unavailable` | 비밀 저장소를 못 읽음(잠긴 Keychain 등). 기한까지 다시 시도 |
| `config_invalid` | 설정 파일이 잘못됐거나 권한이 넓음 |
| `input_invalid`, `input_unreadable` | 훅 입력을 알아볼 수 없음. CLI 업데이트로 필드가 바뀌었을 수 있음 |
| `connection_removed` | 큐에 남은 이벤트의 연결을 설정에서 지움 |

재시도는 지수 backoff(5초부터 최대 15분, 지터)와 서버의 `Retry-After`를 따르고, 시도당 연결 2초·전체 5초로 끊습니다. 큐는 `$XDG_STATE_HOME/r08-helper`(기본 `~/.local/state/r08-helper`)에 있습니다.

## 알고 쓸 것

- **전달을 보장하지 않습니다.** 큐에 넣기 전에 훅이 죽거나(`claude -p` 종료 때 남은 async 훅이 끝날 수 있음), 기기가 24시간 넘게 꺼져 있거나, 봇이 그만큼 내려가 있으면 알림이 없습니다.
- **Claude Stop이 곧 작업 완료는 아닙니다.** 사용자 중단과 API 오류에는 발생하지 않지만, 다른 Stop 훅이 턴을 이어 가게 하면 한 턴에 알림이 둘 이상 올 수 있습니다.
- **기기별로 따로 연결합니다.** 같은 seed를 여러 기기에 복사하지 마세요. 분실하면 봇에서 그 연결을 `/detach`하고 tailnet에서 그 노드도 철회하세요. 둘은 서로를 대신하지 않습니다.
- **Tailscale이 끊기면 알림이 늦습니다.** 로그아웃·다른 VPN 충돌·회사망 제한이면 큐에 쌓였다가 24시간 안에 다시 연결될 때 나갑니다.
- **연결은 30일 뒤 만료됩니다.** 그 뒤에는 수신이 401이고 `/attach`로 다시 연결합니다. 봇 DB를 복원하거나 장애 조치가 일어나면 모든 연결이 닫혀 다시 연결해야 합니다.
- **비밀 저장소도 같은 사용자 권한의 악성 코드까지 막지는 못합니다.**

실제 CLI 버전별 필드와 절전 복귀 동작은 시험하지 않았습니다. 시험은 공식 문서의 필드로 만든 합성 입력을 씁니다.
