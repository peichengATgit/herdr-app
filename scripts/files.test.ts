import { test, expect } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = await readFile(new URL("../defaults/mods/files/main.js", import.meta.url), "utf8");
const directorySource = source.slice(source.indexOf("async function directory("), source.indexOf("\nexport default class"));
const loadDirectory = (exec: Function, platform: string) => new Function("exec", "window", `${directorySource}; return directory;`)(exec, () => ({ platform }));
const directory = loadDirectory(
  async (command: string, args: string[]) => {
    // Hidden like the app's spawns: a visible console would give PowerShell UTF-8 and hide code page bugs.
    const p = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, stdout, stderr };
  },
  process.platform === "win32" ? "windows" : process.platform,
);

test("Files retries a remote Windows directory with PowerShell on that machine", async () => {
  const calls: { command: string; args: string[]; on: string }[] = [];
  const list = loadDirectory(async (command: string, args: string[], options: { on: string }) => {
    calls.push({ command, args, on: options.on });
    if (command === "sh") throw new Error("herdr.exec: cannot start sh: program not found");
    return { code: 0, stdout: '{"name":"中文.txt","dir":false}', stderr: "" };
  }, "linux");
  const path = "C:/O’Brien's $folder";
  expect(await list(path, "winvm")).toEqual([{ name: "中文.txt", dir: false }]);
  expect(calls.map(c => [c.command, c.on])).toEqual([["sh", "winvm"], ["powershell", "winvm"]]);
  expect(calls[0].args.at(-1)).toBe(path);
  expect(calls[1].args.at(-1)).toContain("'C:/O’’Brien''s $folder'");
  expect(calls[1].args.at(-1)).toContain("[Console]::OutputEncoding");
});

test("Files does not mask remote command failures with PowerShell", async () => {
  for (const failure of [new Error("connection lost"), new Error("cannot start sh: permission denied"), { code: 1, stdout: "", stderr: "folder denied" }]) {
    const calls: string[] = [];
    const list = loadDirectory(async (command: string) => {
      calls.push(command);
      if (failure instanceof Error) throw failure;
      return failure;
    }, "linux");
    await expect(list("/folder", "linuxvm")).rejects.toThrow(failure instanceof Error ? failure.message : failure.stderr);
    expect(calls).toEqual(["sh"]);
  }
});

test("Files keeps remote POSIX directory listings on sh", async () => {
  const calls: string[] = [];
  const list = loadDirectory(async (command: string) => {
    calls.push(command);
    return { code: 0, stdout: "d\0folder\0f\0file.txt\0", stderr: "" };
  }, "windows");
  expect(await list("/folder", "linuxvm")).toEqual([{ name: "folder", dir: true }, { name: "file.txt", dir: false }]);
  expect(calls).toEqual(["sh"]);
});

test("Files lists literal folder names, not shell expressions", async () => {
  const root = await mkdtemp(join(process.platform === "linux" ? "/var/tmp" : tmpdir(), "herdr-files-"));
  try {
    for (const name of ["Test Folder (ACME)", "O'Brien $folder; (ACME)", "O’Brien ‘quoted’ ‚low‛"]) {
      const folder = join(root, name);
      await mkdir(join(folder, "child"), { recursive: true });
      await writeFile(join(folder, "hello.txt"), "hello");
      const entries = await directory(folder, null);
      expect(entries.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
        { name: "child", dir: true }, { name: "hello.txt", dir: false },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Files preserves Unicode names when listing and expanding folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-files-unicode-"));
  try {
    const folder = "中文目录 O'Brien (测试)", file = "项目说明.txt", child = "子文件.txt";
    await mkdir(join(root, folder));
    await writeFile(join(root, file), "hello");
    await writeFile(join(root, folder, child), "hello");
    const entries = await directory(root, null);
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ name: folder, dir: true });
    expect(entries).toContainEqual({ name: file, dir: false });
    expect(await directory(join(root, folder), null)).toEqual([{ name: child, dir: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Files follows directory links one level at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-files-links-"));
  try {
    const target = join(root, "versions");
    await mkdir(target);
    for (let minor = 1; minor <= 9; minor++) {
      await mkdir(join(target, `0.${minor}.0`));
    }
    await writeFile(join(target, "0.9.0", "STORY.md"), "story preview");
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "ordinary.txt"), "ordinary");
    await symlink("versions", join(root, ".kb"), "dir");
    if (process.platform === "win32") await symlink(target, join(root, "junction"), "junction");
    await symlink(join(root, "ordinary.txt"), join(root, "file-link"), "file");
    await symlink(join(root, "missing"), join(root, "dangling"), "dir");
    // A cycle must be listed without recursively walking it.
    await symlink(target, join(target, "loop"), "dir");

    const entries = await directory(root, null);
    expect(entries).toHaveLength(process.platform === "win32" ? 7 : 6);
    if (process.platform === "win32") expect(entries).toContainEqual({ name: "junction", dir: true });
    expect(entries).toContainEqual({ name: ".kb", dir: true });
    expect(entries).toContainEqual({ name: "versions", dir: true });
    expect(entries).toContainEqual({ name: ".hidden", dir: true });
    expect(entries).toContainEqual({ name: "ordinary.txt", dir: false });
    expect(entries).toContainEqual({ name: "file-link", dir: false });
    expect(entries).toContainEqual({ name: "dangling", dir: false });
    const versions = await directory(join(root, ".kb"), null);
    expect(versions).toHaveLength(10);
    for (let minor = 1; minor <= 9; minor++) {
      expect(versions).toContainEqual({ name: `0.${minor}.0`, dir: true });
    }
    expect(versions).toContainEqual({ name: "loop", dir: true });
    expect(await directory(join(root, ".kb", "0.9.0"), null)).toEqual([{ name: "STORY.md", dir: false }]);
    expect(await readFile(join(root, ".kb", "0.9.0", "STORY.md"), "utf8")).toBe("story preview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function filesHarness(read: Function = async () => "hello\nworld") {
  const pending: Promise<unknown>[] = [], reads: unknown[] = [], editors: any[] = [];
  let request: any = null;
  const tree = { id: "panel", type: "column", hidden: true, children: [{ type: "block", content: { mod: "files" } }] };
  const Files = new Function("View", "readTextFile", "EditorState", "theme", "settings", "LANG", "shared", "setShared", "layout", "location", "filesVisible",
    source.slice(source.indexOf("export default class")).replace("export default ", "") + "; return Files;")(
    class {}, async (...args: unknown[]) => { reads.push(args); return read(...args); },
    { new: (options: any) => { const editor = { options, release() {} }; editors.push(editor); return editor; } },
    () => ({}), () => ({ font_family: "mono" }), {}, () => request, (_key: string, value: any) => { request = value; }, () => tree,
    () => ({ space: "s1" }), new Function(source.slice(source.indexOf("function filesVisible("), source.indexOf("const key =")) + "; return filesVisible;")(),
  );
  const files = new Files();
  files.context = {}; files.root = "/project"; files.on = null; files.current = () => true;
  const cx = { spawn: (f: Function) => pending.push(f(cx)), notify() {} };
  return { files, cx, reads, editors, tree, pending, request: (value: any) => { request = value; }, currentRequest: () => request };
}

test("Files previews absolute local links outside its root and keeps relative remote previews remote", async () => {
  const h = filesHarness();
  h.files.on = "server";
  h.files.show("/another/project/source.rs", h.cx, { line: 1124 }, null);
  await Promise.all(h.pending);
  expect(h.reads[0]).toEqual(["/another/project/source.rs", { on: null }]);
  expect(h.files.position).toEqual({ line: 1124 });
  h.files.show("src/main.rs", h.cx);
  await Promise.all(h.pending);
  expect(h.reads[1]).toEqual(["/project/src/main.rs", { on: "server" }]);
});

test("a Files link waits for the hidden panel to open, consumes once, and respects its space", () => {
  const h = filesHarness();
  const opened: unknown[] = [];
  h.files.show = (...args: unknown[]) => opened.push(args);
  const request = { id: "one", path: "/project/main.rs", line: 42, column: 7, space: "s1" };
  h.request(request);
  h.files.openRequested(h.cx);
  expect(opened).toHaveLength(0);
  expect(h.currentRequest()).toBe(request);
  h.tree.hidden = false;
  h.files.openRequested(h.cx);
  h.files.openRequested(h.cx);
  expect(opened).toEqual([[request.path, h.cx, { line: 42, column: 7 }, null]]);
  expect(h.currentRequest()).toBeNull();
  h.request({ ...request, space: "s2" });
  h.files.openRequested(h.cx);
  expect(opened).toHaveLength(1);
});

test("a newer click on the same file wins when preview reads finish out of order", async () => {
  const resolvers: ((value: string) => void)[] = [];
  const h = filesHarness(() => new Promise<string>(resolve => resolvers.push(resolve)));
  h.files.show("main.rs", h.cx, { line: 1 });
  h.files.show("main.rs", h.cx, { line: 42 });
  resolvers[1]("new"); await h.pending[1];
  resolvers[0]("old"); await h.pending[0];
  expect(h.editors).toHaveLength(1);
  expect(h.files.code.options.value).toBe("new");
  expect(h.files.position.line).toBe(42);
});

test("the tab bar reveals Files once for each new link request", async () => {
  const tabsSource = await readFile(new URL("../defaults/mods/tabs/main.js", import.meta.url), "utf8");
  let request: any = { id: "one", space: "s1" };
  const commands: unknown[] = [];
  const Tabs = new Function("View", "shared", "run", tabsSource.slice(tabsSource.indexOf("export default class")).replace("export default ", "") + ";return Tabs;")(
    class {}, () => request, (...args: unknown[]) => commands.push(args),
  );
  const tabs = new Tabs();
  tabs.openFileRequest({ id: "s2" }, {}, {});
  expect(commands).toHaveLength(0);
  tabs.openFileRequest({ id: "s1" }, {}, {});
  tabs.openFileRequest({ id: "s1" }, {}, {});
  expect(commands).toEqual([["layout.select", { stack: "panel-body", child: "files" }], ["layout.show", { id: "panel" }]]);
  request = { id: "two", space: "s1" };
  tabs.openFileRequest({ id: "s1" }, {}, {});
  expect(commands).toHaveLength(4);
});

test("remote link requests keep their machine for absolute paths and positions", async () => {
  const h = filesHarness();
  h.tree.hidden = false;
  h.request({ id: "remote", space: "s1", machine: "sjc-ads-1046", path: "/nobackup/project/Makefile", line: 19, column: 3 });
  h.files.openRequested(h.cx);
  await Promise.all(h.pending);
  expect(h.reads).toEqual([["/nobackup/project/Makefile", { on: "sjc-ads-1046" }]]);
  expect(h.files.position).toEqual({ line: 19, column: 3 });
  expect(h.files.fileMachine).toBe("sjc-ads-1046");
});

test("identical paths on different machines cannot reuse a stale preview", async () => {
  const resolvers: ((text: string) => void)[] = [];
  const h = filesHarness(() => new Promise<string>(resolve => resolvers.push(resolve)));
  h.files.show("/project/source.rs", h.cx, { line: 1 }, "server-a");
  h.files.show("/project/source.rs", h.cx, { line: 19 }, "server-b");
  resolvers[1]("server b"); await h.pending[1];
  resolvers[0]("server a"); await h.pending[0];
  expect(h.reads).toEqual([["/project/source.rs", { on: "server-a" }], ["/project/source.rs", { on: "server-b" }]]);
  expect(h.editors).toHaveLength(1);
  expect(h.files.code.options.value).toBe("server b");
  expect(h.files.fileMachine).toBe("server-b");
});

test("unavailable remote files report their machine and never fall back to local reads", async () => {
  for (const result of [null, new Error("machine is offline")]) {
    const h = filesHarness(async () => { if (result instanceof Error) throw result; return result; });
    h.files.show("/project/Makefile", h.cx, null, "server-a");
    await Promise.all(h.pending);
    expect(h.reads).toEqual([["/project/Makefile", { on: "server-a" }]]);
    expect(h.files.code).toBeNull();
    expect(h.files.fileError).toContain("server-a");
    if (result instanceof Error) expect(h.files.fileError).toContain("offline");
  }
});

test("absolute paths chosen from a remote Files tree stay on that machine", async () => {
  const h = filesHarness();
  h.files.on = "server-a";
  h.files.show("/project/Makefile", h.cx);
  await Promise.all(h.pending);
  expect(h.reads).toEqual([["/project/Makefile", { on: "server-a" }]]);
});
