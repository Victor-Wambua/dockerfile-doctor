import os

from fastapi import FastAPI

app = FastAPI(title="sample-api")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> dict[str, int]:
    return {"uid": os.getuid()}
