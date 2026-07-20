import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr || result.stdout || "");
    }
    throw new Error(`${command} ${args.join(" ")} failed`);
  }

  return options.capture ? result.stdout.trim() : "";
}

function fail(message) {
  console.error(`\n发布已停止：${message}`);
  process.exit(1);
}

const target = process.argv[2];
if (target === "--help" || target === "-h") {
  console.log(`Usage:
  npm run release -- patch
  npm run release -- minor
  npm run release -- major
  npm run release -- 1.2.3`);
  process.exit(0);
}

if (!target || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(target)) {
  fail("版本参数必须是 patch、minor、major 或完整的 x.y.z 版本号");
}

const branch = run("git", ["branch", "--show-current"], { capture: true });
if (branch !== "main") fail(`当前分支是 ${branch || "detached HEAD"}，请切换到 main`);

const changes = run("git", ["status", "--porcelain"], { capture: true });
if (changes) fail("工作区存在未提交修改，请先提交或暂存处理");

console.log("检查远程 main 分支…");
run("git", ["fetch", "origin", "main"]);
const localHead = run("git", ["rev-parse", "HEAD"], { capture: true });
const remoteHead = run("git", ["rev-parse", "origin/main"], { capture: true });
if (localHead !== remoteHead) {
  fail("本地 main 与 origin/main 不一致，请先运行 git pull --ff-only");
}

console.log("运行发布前构建…");
run(npmCommand, ["run", "build"]);

console.log(`升级版本：${target}`);
run(npmCommand, [
  "version",
  target,
  "--tag-version-prefix=",
  "--message",
  "chore: release %s",
]);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;

console.log(`推送 main 和 ${version} tag…`);
run("git", ["push", "origin", branch]);
run("git", ["push", "origin", version]);

console.log(`\n发布 ${version} 已推送。GitHub Actions 将创建正式 Release。`);
