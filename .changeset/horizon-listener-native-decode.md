---
'horizon-listener': minor
---

Add `decode: 'none' | 'native'` to `RpcEventSourceOptions`. Native mode applies
`scValToNative` to topics and value with JSON-safe encoding (bigint as string,
bytes as hex). Raw mode remains the default.
