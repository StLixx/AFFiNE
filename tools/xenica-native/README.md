# Xenica Harness 原生执行接口（实施中）

来源：StLixx/Xenica#139；产品源码与几何/性能改动继续关联本Fork原生候选。该目录不改变界面设计。

本次实际产品构建、模型/性能/冻结/恢复验证只在Infra的xenica-dev-run统一4CPU/6GiB预算中执行。GitHub仅核验实际两仓source/tree、产物与固定合同、受控worker签名和当前运行身份；不新增GitHub-hosted原生构建，不注册self-hosted runner。

后续脚本须复用真实原生web构建（yarn affine @affine/web build）和原生产品测试入口，不能用网关或旧Xenica示意应用通过替代。尚缺实际构建/原生专项时不声明通过；读取既有源码或通过格式单测不等于真实产物已验证。

## Fork CI 路由

对目标分支 `xenica/stable-0.27.4` 的 PR，`.github/workflows/build-test.yml` 不再派发 GitHub-hosted 全产品构建；上游其它 PR、push 与 merge-group 路径保持原样。此处不生成「通过」占位检查，也不使用 skip-ci 绕过验证。该 Fork 线必须由 Infra 的 `xenica-dev-run` 执行真实原生构建与专项，受控签名收据由 StLixx/Xenica 的 `native-proof.cjs` 在原有 Harness 交付链验证 exact source/tree、不可变 image/web、固定合同与当前工程 request/run/attempt；缺实际证据仍 pending。正式控制器及自动恢复调度尚未合入主线时，仅可标为受审 exact source 的一次性执行，不宣称自动交付链已经运行。

`node --test tools/xenica-native/ci-routing.test.mjs` 只验证路由，不能替代产品构建、Frames 性能或用户体验验收。
