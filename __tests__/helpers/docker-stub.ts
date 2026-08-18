import type { DockerRunner } from "../../src/docker.js";
import { startAgentStub } from "./agent-stub.js";
import type { StubServer } from "./agent-stub.js";

export interface FakeContainer {
  stub: StubServer;
  stopped: boolean;
  hostPort: number;
  params?: { image: string; hostDir: string };
}

/** Fake docker runner: each runContainer starts a real stub on a random port and records params. */
export function makeFakeDockerRunner() {
  const spawned: FakeContainer[] = [];
  const runner: DockerRunner = {
    async runContainer(params) {
      const stub = startAgentStub({ terminalStatus: "finished" });
      const hostPort = Number(new URL(stub.url).port);
      const record: FakeContainer = { stub, stopped: false, hostPort, params };
      spawned.push(record);
      return {
        name: `agent-server-test-${spawned.length}`,
        hostPort,
        stop: async () => {
          record.stopped = true;
          stub.close();
        },
      };
    },
  };
  return { runner, spawned };
}