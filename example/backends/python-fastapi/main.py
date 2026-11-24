# POST /api/bolna-session: mints a short-lived Bolna web-call session with YOUR bn- key
# (server-side only) and returns it unchanged to the browser SDK.
# Run:  BOLNA_API_KEY=bn-... BOLNA_AGENT_ID=... uvicorn main:app --port 8787
import os

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

API_KEY = os.environ["BOLNA_API_KEY"]
AGENT_ID = os.environ.get("BOLNA_AGENT_ID", "")
API_BASE = os.environ.get("BOLNA_API_BASE", "https://api.bolna.ai")

app = FastAPI()


@app.post("/api/bolna-session")
async def bolna_session(request: Request):
    # Add YOUR user auth here so only signed-in users can start calls.
    try:
        user_data = (await request.json()).get("user_data")
    except ValueError:
        user_data = None

    payload = {"agent_id": AGENT_ID}
    if user_data is not None:
        payload["user_data"] = user_data  # forwarded from the SDK's userData

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{API_BASE}/web-call/session",
                headers={"Authorization": f"Bearer {API_KEY}"},
                json=payload,
            )
    except httpx.HTTPError:
        return JSONResponse({"message": "session mint failed"}, status_code=502)
    return JSONResponse(r.json(), status_code=r.status_code)
