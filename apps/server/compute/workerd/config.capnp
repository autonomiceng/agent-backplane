using W = import "/workerd/workerd.capnp";
const config :W.Config = (
  services = [
    (name="loader", worker=(
      compatibilityDate="2026-01-01",
      compatibilityFlags=["enable_ctx_exports"],
      modules=[(name="loader.js", esModule=embed "loader.js")],
      globalOutbound="internet",
      bindings=[
        (name="LOADER", workerLoader=()),
        (name="TOKEN", fromEnvironment="BP_COMPUTE_TOKEN"),
        (name="API", service="api")
      ]
    )),
    (name="api", external=(address="server:3000", http=())),
    (name="internet", network=(
      allow=["public"], tlsOptions=(trustBrowserCas=true)
    ))
  ],
  sockets=[(name="control", address="*:8080", http=(), service="loader")]
);
