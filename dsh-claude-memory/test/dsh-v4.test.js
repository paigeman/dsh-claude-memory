import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { apply } from "../index.js";
import {
  cleanup,
  ensureDir,
  fakeAgent,
  fakeCtx,
  makeTemp,
  memoryPath,
  userMessage,
} from "./helpers.js";

// Point this at the installed DSH module and run with its Electron Node runtime
// when the module is inside app.asar. No DSH Host or network request is started.
const formatModule = process.env.DSH_SESSION_FORMAT_MODULE;

test(
  "memory injections pass the native DSH V4 encoder",
  {
    skip: formatModule ? false : "Set DSH_SESSION_FORMAT_MODULE to test the installed DSH encoder",
  },
  async (t) => {
    const { releasedV4SessionFormatCodec: codec } = await import(pathToFileURL(formatModule).href);
    assert.equal(codec.version, 4);

    for (const scenario of [
      {
        name: "automatic index",
        prompt: "Please review the current plan.",
        form: "index",
        hasMemory: true,
      },
      {
        name: "explicit full recall",
        prompt: "请加载 memory",
        form: "full-recall",
        hasMemory: true,
      },
      {
        name: "missing memory notice",
        prompt: "请加载 memory",
        form: "full-recall",
        hasMemory: false,
      },
    ]) {
      await t.test(scenario.name, async (t) => {
        const temp = makeTemp();
        t.after(() => cleanup(temp));
        const project = join(temp, "project");
        const configDir = join(temp, "home", ".claude");
        ensureDir(project);
        if (scenario.hasMemory) {
          memoryPath(configDir, project, {
            "MEMORY.md": "# Index\n- [Build](build.md) — build instructions\n",
            "build.md": "Use make build.\n",
          });
        }
        const fake = fakeCtx();
        apply(fake.ctx, { configDir });
        t.after(() => fake.dispose());
        const agent = fakeAgent(project);
        const messages = [userMessage(scenario.prompt)];
        const decision = await fake.preStep(agent, messages);
        assert.equal(decision.kind, "enter");
        assert.equal(
          decision.messages.length,
          1,
          "memory must not enter durable pre-step messages",
        );
        const request = await fake.modelRequest(agent, decision.messages);
        assert.equal(request.dispatches, 1);
        const injected = request.messages.find((message) => message.source?.form === scenario.form);
        assert.ok(injected, "the scenario must exercise an actual plugin injection");

        for (const [seq, message] of decision.messages.entries()) {
          assert.doesNotThrow(() =>
            codec.encodeEvent({
              type: "user/message",
              seq,
              time: 1,
              data: message,
              surfaceOp: "append",
            }),
          );
        }
        assert.doesNotThrow(() =>
          codec.encodeEvent({
            type: "user/message",
            seq: 1,
            time: 1,
            data: injected,
            surfaceOp: "append",
          }),
        );
        assert.doesNotThrow(() =>
          codec.encodeEvent({
            type: "agent/inbox/spliced",
            seq: 0,
            time: 1,
            data: { target: "next-step", start: 0, inserted: [injected] },
          }),
        );
        assert.equal(injected.source.kind, "claude-memory");
        assert.equal(injected.source.plugin, undefined);
      });
    }
  },
);
