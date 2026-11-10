export default {
  owner: { login: "octo", id: 42 },
  github: { appId: 7, privateKeyPath: "/nonexistent/app.pem" },
  repos: [{ name: "octo/app", setup: "bun install" }],
  roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
};
