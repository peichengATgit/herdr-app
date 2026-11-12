import { test, expect } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = (await readFile(new URL("../defaults/mods/changes/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default class Changes", "class Changes");

function harness(cwd: string, storage: Record<string, any> = {}) {
  let current = { cwd, space: "s1", on: null as string | null };
  const calls: any[] = [], watched: string[] = [], pending: Promise<any>[] = [];
  const exec = async (command: string, args: string[], options: any) => {
    calls.push({ command, args, ...options });
    const process = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { code, stdout, stderr };
  };
  const globals = {
    View: class {}, spaces: () => [{ id: current.space, active: true, machine: current.on, folder: current.cwd }],
    panes: () => [{ pane: "p1", cwd: current.cwd }], focused: () => ({ pane: "p1" }), exec,
    shared: (key: string) => storage[key], setShared: (key: string, value: any) => { storage[key] = value; },
    readTextFile: (path: string) => readFile(path, "utf8"),
    watchFolder: (path: string) => { watched.push(path); return new Promise(() => {}); },
  };
  const Changes = new Function(...Object.keys(globals), `${source}; return Changes;`)(...Object.values(globals));
  const view = new Changes();
  Object.assign(view, { files: [], rows: [], message: "", input: { set_value() {} } });
  // Watch loops remain pending; refresh/commit tasks are drained explicitly.
  const cx = { notify() {}, spawn(fn: any) { const task = fn(cx); pending.push(task); } };
  const drain = async () => {
    while (pending.length) {
      const tasks = pending.splice(0);
      await Promise.all(tasks);
    }
  };
  // Avoid waiting for the intentionally endless folder-watch task.
  view.watch = (path: string) => { if (!current.on) watched.push(path); };
  return { view, cx, calls, watched, storage, exec, drain,
    move: (changes: Partial<typeof current>) => { current = { ...current, ...changes }; },
    refresh: async () => { view.refresh(cx); await drain(); },
    pin: async () => { view.setScope(true, cx); await drain(); },
    clear: async () => { view.setScope(false, cx); await drain(); },
  };
}

async function fixture(run: (root: string, owned: string, h: ReturnType<typeof harness>) => Promise<void>, unborn = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-changes-"))), owned = join(root, "owned [a] space");
  try {
    await mkdir(owned);
    await mkdir(join(root, "sibling"));
    const h = harness(owned);
    for (const args of [["init"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) {
      expect((await h.exec("git", args, { cwd: root })).code).toBe(0);
    }
    await writeFile(join(owned, "tracked.txt"), "before\n");
    await writeFile(join(root, "sibling", "other.txt"), "before\n");
    await h.exec("git", ["add", "."], { cwd: root });
    if (!unborn) {
      expect((await h.exec("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: root })).code).toBe(0);
      await writeFile(join(owned, "tracked.txt"), "after\n");
      await writeFile(join(root, "sibling", "other.txt"), "outside\n");
      await h.exec("git", ["add", "sibling"], { cwd: root });
    }
    await writeFile(join(owned, "new.txt"), "new\n");
    await run(root, owned, h);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("pinned scope filters Git queries, counts and previews; whole repository restores siblings", async () => {
  await fixture(async (root, owned, h) => {
    await h.pin();
    expect(h.view.error).toBeNull();
    expect(h.view.files.map((f: any) => f.path).sort()).toEqual(["owned [a] space/new.txt", "owned [a] space/tracked.txt"]);
    expect(h.view.files.find((f: any) => f.path.endsWith("tracked.txt"))).toMatchObject({ add: 1, del: 1 });
    expect(h.watched.at(-1)).toBe(`${root}/owned [a] space/`);
    for (const call of h.calls.filter(c => c.args.includes("--numstat") || c.args.includes("status"))) {
      expect(call.args.slice(-2)).toEqual(["--", ":(top,literal)owned [a] space/"]);
    }
    h.view.open = "owned [a] space/tracked.txt";
    await h.view.load(h.view.open, h.view.context);
    expect(h.view.rows.some((r: any) => r.text === "after")).toBe(true);
    h.view.open = "owned [a] space/new.txt";
    await h.view.load(h.view.open, h.view.context);
    expect(h.view.rows.some((r: any) => r.text === "new")).toBe(true);
    h.move({ cwd: join(root, "sibling") });
    await h.refresh();
    expect(h.view.files).toHaveLength(2);
    const reloaded = harness(join(root, "sibling"), h.storage);
    await reloaded.refresh();
    expect(reloaded.view.files).toHaveLength(2);
    await h.clear();
    expect(h.view.files).toHaveLength(3);
    expect(h.watched.at(-1)).toBe(root);
  });
});

test("scopes are separate per space and machine; remote queries keep the pinned host", async () => {
  await fixture(async (root, owned, h) => {
    h.move({ on: "remote" });
    await h.pin();
    expect(h.calls.filter(c => c.args.includes("status")).at(-1).on).toBe("remote");
    expect(h.watched).toEqual([]);
    h.move({ space: "s2" });
    await h.refresh();
    expect(h.view.files).toHaveLength(3);
    h.move({ space: "s1", on: null });
    await h.refresh();
    expect(h.view.files).toHaveLength(3);
    h.move({ space: "s1", on: "remote", cwd: join(root, "sibling") });
    await h.refresh();
    expect(h.view.files).toHaveLength(2);
    expect(h.calls.filter(c => c.args.includes("status")).at(-1)).toMatchObject({ on: "remote", cwd: root });
  });
});

test("directory scope refuses commit and leaves outside staged changes untouched", async () => {
  await fixture(async (root, owned, h) => {
    await h.pin();
    const before = await h.exec("git", ["diff", "--cached"], { cwd: root });
    const head = await h.exec("git", ["rev-parse", "HEAD"], { cwd: root });
    const offset = h.calls.length;
    h.view.message = "must not commit";
    h.view.commit(h.cx);
    await h.drain();
    expect(h.calls.slice(offset)).toEqual([]);
    expect((await h.exec("git", ["diff", "--cached"], { cwd: root })).stdout).toBe(before.stdout);
    expect((await h.exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout).toBe(head.stdout);
  });
});

test("unborn repositories scope staged and unstaged statistics", async () => {
  await fixture(async (_root, _owned, h) => {
    await h.pin();
    expect(h.view.error).toBeNull();
    expect(h.view.hasHead).toBe(false);
    expect(h.view.files).toHaveLength(2);
    expect(h.view.files.find((f: any) => f.path.endsWith("tracked.txt"))).toMatchObject({ add: 1, del: 0 });
    expect(h.calls.filter(c => c.args.includes("--numstat"))).toHaveLength(2);
  }, true);
});

test("pinning the repository root still shows all files and disables commit", async () => {
  await fixture(async (root, _owned, h) => {
    h.move({ cwd: root });
    await h.pin();
    expect(h.view.error).toBeNull();
    expect(h.view.files).toHaveLength(3);
    expect(h.calls.filter(c => c.args.includes("status")).at(-1).args.slice(-2)).toEqual(["--", "."]);
    h.view.message = "blocked";
    const before = h.calls.length;
    h.view.commit(h.cx);
    await h.drain();
    expect(h.calls).toHaveLength(before);
  });
});

test("a missing pinned directory reports failure without a repository-wide fallback", async () => {
  await fixture(async (root, _owned, h) => {
    await h.pin();
    h.move({ cwd: join(root, "missing") });
    const before = h.calls.length;
    await h.pin();
    expect(h.view.error).toContain("Error");
    expect(h.view.files).toEqual([]);
    expect(h.calls.slice(before).some(c => c.args.includes("status"))).toBe(false);
  });
});
