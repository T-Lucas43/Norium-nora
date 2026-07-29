from pydantic import BaseModel, ConfigDict


class StrictModel(BaseModel):
    """Base única dos payloads públicos; preserva a rejeição de campos extras."""

    model_config = ConfigDict(extra="forbid")
