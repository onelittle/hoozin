local_resource("bun-dev",
  serve_cmd="bun run dev",
  serve_env={
    "VITE_GOOGLE_OAUTH_CLIENT_ID": "755761570634-k69o0r01al6q03dtpupg036g0oj7p3hc.apps.googleusercontent.com",
  },
  links=[
    "http://localhost:5173",
  ],
  resource_deps=["bun-install"]
)

local_resource("bun-install",
  cmd="bun install",
  deps=["./package.json", "./bun.lock"],
)
