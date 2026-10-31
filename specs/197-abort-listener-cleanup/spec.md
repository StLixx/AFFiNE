# 后台异步队列中止监听器清理

关联 https://github.com/StLixx/Xenica/issues/197 与 #183 的运行时取证。成功唤醒后未清理的AbortSignal回调会在长期signal上累积。此次只修复AsyncPriorityQueue等待路径的清理；优先级、共享等待与返回值不变，UI/IA/Icons不变。

先使用真实AbortController、原生getEventListeners和现有Vitest写红例。覆盖重复成功、等待中止、已中止、多个等待者、最低优先级以及不传signal；保留原队列/二叉树回归。资源仍走Infra原4CPU/6GiB，不安装新依赖。

单测通过后才构建真实原生产物，在原零增长、17Frame、内容/视觉和5GiB快照中止标准下重新验证。临时取证只提供归属证据，不冒充完整产品通过。用户实际体验验收前不合并交互主线。
