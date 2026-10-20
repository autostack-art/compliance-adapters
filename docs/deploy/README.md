# Scheduling `sanctions-oracle` syncs

Sync is meant to run on a schedule. Both examples below run the
`compliance-adapters sync-sanctions` CLI, prevent overlapping runs, and mount
the signing secret as a file (never as a CLI flag, which leaks via `ps` and
shell history).

| Example | Overlap prevention | Secret handling |
| --- | --- | --- |
| [`kubernetes/sanctions-sync-cronjob.yaml`](./kubernetes/sanctions-sync-cronjob.yaml) | `concurrencyPolicy: Forbid` | Secret volume, mode `0400` |
| [`systemd/sanctions-sync.service`](./systemd/sanctions-sync.service) + [`.timer`](./systemd/sanctions-sync.timer) | `Type=oneshot` (timer never starts a second instance) | `LoadCredential=` |

## Validate

```sh
kubectl apply --dry-run=client -f docs/deploy/kubernetes/sanctions-sync-cronjob.yaml
systemd-analyze verify docs/deploy/systemd/sanctions-sync.service docs/deploy/systemd/sanctions-sync.timer
```

## Install (systemd)

```sh
sudo cp docs/deploy/systemd/sanctions-sync.* /etc/systemd/system/
sudo install -m 0400 -o root /path/to/secret-key /etc/sanctions-oracle/secret-key
sudo systemctl daemon-reload && sudo systemctl enable --now sanctions-sync.timer
```

Tip: run once with `--dry-run` first to check the fee estimate and the planned writes.
