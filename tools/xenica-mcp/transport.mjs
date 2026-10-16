import { io } from "socket.io-client";
export class Transport {
  constructor(config) {
    this.config = config;
    this.connecting = null;
    this.socket = null;
  }
  async connect() {
    if (this.socket?.connected) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  async open() {
    const c = this.config;
    const r = await fetch(c.upstream_url + "/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: c.public_url },
      body: JSON.stringify({ email: c.email, password: c.password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Error("UPSTREAM_AUTH_FAILED");
    const cookie = r.headers
      .getSetCookie()
      .map((h) => h.split(";")[0])
      .join("; ");
    const query = await (
      await fetch(c.upstream_url + "/graphql", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "query { currentUser { id } workspaces { id } }",
        }),
        signal: AbortSignal.timeout(15000),
      })
    ).json();
    if (
      query.data?.currentUser?.id !== c.owner_id ||
      !query.data?.workspaces?.some((w) => w.id === c.workspace_id)
    )
      throw Error("UPSTREAM_IDENTITY_MISMATCH");
    const socket = io(c.upstream_url, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: { Cookie: cookie },
      reconnection: false,
      timeout: 15000,
    });
    try {
      await new Promise((yes, no) => {
        socket.once("connect", yes);
        socket.once("connect_error", () =>
          no(Error("UPSTREAM_CONNECTION_FAILED")),
        );
      });
      const result = await this.emit(socket, "space:join", {
        clientVersion: "0.27.4",
      });
      if (!result.success) throw Error("UPSTREAM_WORKSPACE_DENIED");
      this.socket = socket;
      return socket;
    } catch (error) {
      socket.disconnect();
      throw error;
    }
  }
  emit(socket, event, args) {
    return new Promise((yes, no) =>
      socket
        .timeout(20000)
        .emit(
          event,
          {
            spaceType: "workspace",
            spaceId: this.config.workspace_id,
            ...args,
          },
          (error, result) =>
            error
              ? no(Error("UPSTREAM_TIMEOUT"))
              : result?.error
                ? no(
                    Error(
                      result.error.code === "DOC_NOT_FOUND"
                        ? "UPSTREAM_DOC_NOT_FOUND"
                        : "UPSTREAM_PERMISSION_OR_SYNC_ERROR",
                    ),
                  )
                : yes(result?.data ?? result),
        ),
    );
  }
  async load(docId) {
    try {
      const r = await this.emit(await this.connect(), "space:load-doc", {
        docId,
      });
      return Buffer.from(r.missing || "", "base64");
    } catch (error) {
      if (error.message === "UPSTREAM_DOC_NOT_FOUND") return Buffer.alloc(0);
      throw error;
    }
  }
  async push(docId, binary) {
    const r = await this.emit(await this.connect(), "space:push-doc-update", {
      docId,
      update: Buffer.from(binary).toString("base64"),
    });
    if (!r?.accepted) throw Error("UPSTREAM_WRITE_REJECTED");
    return r;
  }
  close() {
    this.socket?.disconnect();
    this.socket = null;
  }
}
