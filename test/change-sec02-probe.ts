// 악성 src/server.test.ts의 내용. 고정 Bun이 샌드박스 안에서 실제로 돌린다. 결과는 PROBE 줄로만 나간다. 시험 프로세스에는 다른 출구가 없다.
export const CANARY = 'CANARYT19SEC02VALUE0123456789ABCDEF';
export interface ProbeTargets { credential: string; control: string; otherSession: string; ownConfig: string; ownRun: string; socket: string; tcpPort: number; state: string; marker: string }
export const PROBE_BODY = (t: ProbeTargets): string => `import { test } from "bun:test";
import { chmodSync, readFileSync, readdirSync, writeFileSync, symlinkSync, linkSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
const CANARY = ${JSON.stringify(CANARY)};
const say = (name: string, value: string) => console.log("PROBE " + name + "=" + value);
const read = (name: string, path: string) => { try { say(name, readFileSync(path, "utf8").includes(CANARY) ? "leaked" : "read_clean"); } catch (error: any) { say(name, error.code ?? "error"); } };
const write = (name: string, path: string) => { try { writeFileSync(path, "x"); say(name, "wrote"); } catch (error: any) { say(name, error.code ?? "error"); } };
const conn = (name: string, options: any) => new Promise<void>(resolve => {
  const socket = connect(options);
  const done = (value: string) => { say(name, value); socket.destroy(); resolve(); };
  socket.once("connect", () => done("connected"));
  socket.once("error", (error: any) => done(error.code ?? "error"));
  setTimeout(() => done("timeout"), 2000);
});
test("probe", async () => {
  read("read.credential", ${JSON.stringify(t.credential)});
  read("read.control", ${JSON.stringify(t.control)});
  read("read.other_session", ${JSON.stringify(t.otherSession)});
  read("read.own_config", ${JSON.stringify(t.ownConfig)});
  read("read.own_run", ${JSON.stringify(t.ownRun)});
  try { say("list.state", readdirSync(${JSON.stringify(t.state)}).length ? "visible" : "empty"); } catch (error: any) { say("list.state", error.code ?? "error"); }
  try { say("list.app", readdirSync("/app").length ? "visible" : "empty"); } catch (error: any) { say("list.app", error.code ?? "error"); }
  let environ = "absent";
  for (const pid of readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
    for (const leaf of ["environ", "cmdline"]) {
      try { if (readFileSync("/proc/" + pid + "/" + leaf, "utf8").includes(CANARY)) environ = "leaked"; } catch {}
    }
  }
  say("proc.environ_canary", environ);
  say("env.credential_vars", Object.keys(process.env).filter(name => /TOKEN|KEY|SECRET|CLAUDE|ANTHROPIC|GITHUB|PROXY/i.test(name)).length ? "present" : "none");
  say("env.names", Object.keys(process.env).sort().join(","));
  read("alias.proc1_root", "/proc/1/root" + ${JSON.stringify(t.credential)});
  read("alias.proc_self_root", "/proc/self/root" + ${JSON.stringify(t.credential)});
  await conn("net.unix_socket", { path: ${JSON.stringify(t.socket)} });
  await conn("net.tcp_loopback_worker", { host: "127.0.0.1", port: ${t.tcpPort} });
  await conn("net.tcp_external", { host: "1.1.1.1", port: 443 });
  const dns = await Bun.dns.lookup("github.com").then(() => "resolved", (error: any) => "failed");
  say("net.dns", dns);
  write("write.source_new", "/source/evil");
  write("write.source_existing", "/source/src/server.ts");
  write("write.usr", "/usr/evil");
  write("write.root", "/evil");
  write("write.state", ${JSON.stringify(t.state)} + "/evil");
  write("write.scratch", "/scratch/home/ok");
  try { symlinkSync("/source/README.md", "/scratch/home/link"); say("symlink.scratch", readFileSync("/scratch/home/link", "utf8").length ? "follows_source" : "empty"); } catch (error: any) { say("symlink.scratch", error.code ?? "error"); }
  try { symlinkSync("/scratch/home/x", "/source/evil-link"); say("symlink.source", "created"); } catch (error: any) { say("symlink.source", error.code ?? "error"); }
  try { linkSync("/source/README.md", "/scratch/home/hard"); say("hardlink.source", "created"); } catch (error: any) { say("hardlink.source", error.code ?? "error"); }
  try { mkdirSync("/source/evildir"); say("mkdir.source", "created"); } catch (error: any) { say("mkdir.source", error.code ?? "error"); }
  // 파일 권한이 아니라 마운트가 막는지 본다. 소유자는 chmod를 할 수 있어야 하는 자리다.
  try { chmodSync("/source/src/server.ts", 0o644); say("chmod.source", "changed"); } catch (error: any) { say("chmod.source", error.code ?? "error"); }
  const install = Bun.spawnSync(["/opt/verifier/bun-1.4.3/bun", "install", "--no-cache"], { cwd: "/source", stdout: "pipe", stderr: "pipe" });
  say("install.exit", String(install.exitCode));
  const script = Bun.spawnSync(["/opt/verifier/bun-1.4.3/bun", "run", "test"], { cwd: "/source", stdout: "pipe", stderr: "pipe" });
  say("script.leak", (script.stdout.toString() + script.stderr.toString()).includes(CANARY) ? "leaked" : "clean");
  // 새 세션으로 빠져나가 시험이 끝난 뒤에도 남으려는 자식. 표식은 명령줄의 $0 자리에 있다.
  Bun.spawn(["setsid", "sh", "-c", "trap '' TERM HUP INT; while :; do sleep 1; done", ${JSON.stringify(t.marker)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 200));
  say("done", "yes");
}, 60000);
`;
