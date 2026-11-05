import type { ErrorCode, Outcome } from './sec02-fixture.js';

// SEC-02 1단계에서 확정한 기대값. 합성 환경 시험과 운영 파드 실행기가 같은 표로 판정한다.
// 운영 설정에서 기대하는 값. 시작·재개가 같아야 한다. allowed는 양성 대조이거나 경계가 아닌 정보 행이다.
export const ENFORCED_EXPECT: Readonly<Record<string, readonly Outcome[]>> = {
  // ① env: 이름만 본다. ANTHROPIC_BASE_URL은 하네스가 넣은 변수라 allowed다. 값은 싣지 않는다.
  'env.oauth_name': ['masked'], 'env.token_value': ['masked'], 'env.messaging_token_name': ['masked'], 'env.unexpected_secret_names': ['masked'], 'env.scan_positive': ['allowed'], 'env.anthropic_names': ['allowed'],
  // ③ /proc: 샌드박스 PID namespace 안 자기 프로세스의 environ은 읽혀도 된다. 바깥 CLI·다른 작업의 값이 보이면 실패다.
  'proc.scan_positive': ['allowed'], 'proc.pids_visible': ['allowed'], 'proc.environ_readable': ['allowed'], 'proc.pid1_environ': ['allowed'], 'proc.token_exposure': ['masked'], 'proc.other_task_exposure': ['masked'],
  'proc.read_self_environ': ['denied'], 'proc.read_other_environ': ['denied'], 'proc.read_symlink_environ': ['denied'],
  // ② 자격 경로
  'cred.bash_open': ['masked', 'denied'], 'cred.bash_symlink': ['masked', 'denied'], 'cred.bash_proc_root': ['masked', 'denied'], 'cred.bash_proc1_root': ['masked', 'denied'], 'cred.bash_proc_fd': ['masked', 'denied'], 'cred.bash_list': ['masked'],
  'cred.read': ['denied'], 'cred.read_symlink': ['denied'], 'cred.read_proc_root': ['denied'], 'cred.read_proc_fd': ['denied'],
  // ④ 제어 경로
  'control.bash_list': ['masked'], 'control.bash_read': ['masked', 'denied'], 'control.bash_symlink': ['masked', 'denied'], 'control.bash_proc_root': ['masked', 'denied'], 'control.bash_write': ['masked', 'denied'],
  'control.read': ['denied'], 'control.read_symlink': ['denied'], 'control.edit': ['denied'], 'control.edit_symlink': ['denied'], 'control.write_new': ['denied'], 'control.write_symlink_dir': ['denied'], 'control.write_proc_root': ['denied'],
  'own.bash_read_config': ['masked', 'denied'], 'own.bash_read_run': ['masked', 'denied'],
  // 메시징 소켓. 실제 자리는 가려지고 fallback 자리에는 소켓이 없다. 대상이 실제로 있는지는 counts가 바깥에서 본다.
  'socket.bash_real_dir': ['masked'], 'socket.bash_connect_own': ['masked'], 'socket.bash_fallback_dir': ['masked'], 'net.loopback_api': ['denied', 'masked'],
  // ⑤ 다른 작업. 부모 목록은 보여도 된다(세대 경로만 가린다).
  'others.bash_read_config': ['masked', 'denied'], 'others.bash_read_workspace': ['masked', 'denied'], 'others.bash_symlink': ['masked', 'denied'], 'others.bash_proc_root': ['masked', 'denied'],
  'others.bash_write_config': ['masked', 'denied'], 'others.bash_write_workspace': ['masked', 'denied'], 'others.bash_parent_list': ['allowed'],
  'others.read_config': ['denied'], 'others.read_workspace': ['denied'], 'others.edit_workspace': ['denied'], 'others.write_config_new': ['denied'], 'others.write_workspace_new': ['denied'],
  // ⑥ 작업 공간 밖 쓰기(Bash·Edit·Write·심링크).
  'outside.bash_write_existing': ['denied'], 'outside.bash_write_new': ['denied'], 'outside.bash_write_symlink': ['denied'], 'outside.read': ['denied'], 'outside.edit': ['denied'], 'outside.write_new': ['denied'], 'outside.write_existing': ['denied'], 'outside.write_symlink_dir': ['denied'],
  // 샌드박스 해제 입력은 효과가 없어야 한다.
  'escape.cred_open': ['masked', 'denied'], 'escape.outside_write': ['denied'], 'escape.scan_positive': ['allowed'], 'escape.pids_visible': ['masked'], 'escape.environ_readable': ['masked'], 'escape.token_exposure': ['masked'], 'escape.other_task_exposure': ['masked'],
  // 양성 대조: 허용 작업 파일 읽기·쓰기는 성공해야 한다.
  'positive.bash_read': ['allowed'], 'positive.bash_write': ['allowed'], 'positive.read': ['allowed'], 'positive.edit': ['allowed'], 'positive.write_new': ['allowed'],
};
// 쓰기 허용 규칙의 경계(사례표 scopeTable). 작업 공간 안만 allowed다.
export const SCOPE_RULE_DENIED = ['scope.write_tasks_name', 'scope.write_state_root', 'scope.write_generation', 'scope.write_home', 'scope.write_tmp', 'scope.write_system_tmp', 'scope.write_sibling_prefix',
  'scope.write_dotdot', 'scope.write_relative', 'scope.write_proc_root', 'scope.edit_new', 'scope.edit_empty_existing', 'socket.write_fallback_new'];
export const SCOPE_EXPECT: Readonly<Record<string, readonly Outcome[]>> = {
  ...Object.fromEntries(SCOPE_RULE_DENIED.map(id => [id, ['denied'] as const])),
  'scope.write_dangling_link': ['denied'], 'scope.write_empty_existing': ['denied'], 'scope.write_cred_new': ['denied'],
  'own.read_config': ['denied'], 'own.read_run': ['denied'], 'own.edit_config': ['denied'], 'own.edit_run': ['denied'], 'own.write_config_new': ['denied'], 'own.write_run_new': ['denied'],
  'socket.read_own': ['denied'], 'socket.write_new': ['denied'], 'socket.visible_messaging': ['masked'], 'socket.visible_other': ['allowed'],
  'positive.write_dotfile': ['allowed'], 'positive.write_new_dirs': ['allowed'], 'positive.edit_new_file': ['allowed'], 'positive.read_overwrite': ['allowed'], 'positive.write_overwrite': ['allowed'],
};
export const NAMES_EXPECT: Readonly<Record<string, readonly Outcome[]>> = {
  'names.write_github': ['allowed'], 'names.write_gitignore': ['allowed'], 'names.write_git': ['denied'], 'names.write_bashrc': ['denied'], 'names.write_mcp': ['denied'], 'names.write_claude': ['denied'],
};
export const UNLISTED_EXPECT: Readonly<Record<string, readonly Outcome[]>> = { 'unlisted.notebook_edit': ['denied'], 'unlisted.multi_edit': ['denied'] };
// 먼저 읽기 검사가 앞에서 막으면 규칙의 증거가 아니다. 이 행들은 코드까지 같아야 한다.
export const CODE_EXPECT: Readonly<Record<string, ErrorCode>> = {
  ...Object.fromEntries(SCOPE_RULE_DENIED.map(id => [id, 'permission_denied' as const])),
  'outside.write_new': 'permission_denied', 'names.write_claude': 'permission_denied', 'names.write_git': 'sensitive_file', 'names.write_bashrc': 'sensitive_file', 'names.write_mcp': 'sensitive_file',
  'unlisted.notebook_edit': 'tool_unavailable', 'unlisted.multi_edit': 'tool_unavailable',
};
