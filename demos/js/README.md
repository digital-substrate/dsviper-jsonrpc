# Live demo — animate a vertex from JavaScript

Each step is a **real commit** on the `CommitDatabase`, driven from the JS `CommitStore`. Open the
same graph in the **ge-py** editor and watch the vertex move as JavaScript dispatches commits.

1. Serve the directory holding your graph:
   ```sh
   GATEWAY_DB_DIR=/path/to/databases python3 server/app.py
   ```
2. In **ge-py**, open that graph and choose **"go live"**.
3. Run the animation (the database is the file name):
   ```sh
   node demos/js/animate.mjs a.graph 60
   ```
   The vertex sweeps left–right in ge-py, one commit per step.

**Without ge-py** (just to prove the commits flow), run `demo/run.sh`: it serves a throwaway copy of
a freshly-built throwaway fixture and animates against it.
```sh
sh demos/js/run.sh             # builds a throwaway fixture, 12 steps
sh demos/js/run.sh 60
```
