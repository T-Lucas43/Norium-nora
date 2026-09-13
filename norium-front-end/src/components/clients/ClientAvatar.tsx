import { useEffect, useState } from "react";
import { apiBlobRequest } from "../../core/api/client";
import { initials, type Client } from "./clientModel";
export default function ClientAvatar({
  client,
  large = false,
}: {
  client: Client;
  large?: boolean;
}) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let active = true,
      url = "";
    setSource("");
    if (client.avatarId)
      void apiBlobRequest(
        `/api/clientes/${client.id}/avatar?v=${client.avatarId}`,
      )
        .then((blob) => {
          if (active) {
            url = URL.createObjectURL(blob);
            setSource(url);
          }
        })
        .catch(() => undefined);
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client.id, client.avatarId]);
  return (
    <span
      className={`client-avatar ${large ? "client-avatar-large" : ""}`}
      aria-hidden="true"
    >
      {source ? <img src={source} alt="" /> : initials(client.name)}
    </span>
  );
}
