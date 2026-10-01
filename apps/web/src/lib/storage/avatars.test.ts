import { describe, expect, it } from "vitest";

import { avatarPublicUrl, buildAvatarPath, isOwnAvatarPath } from "./avatars";

const USER = "14a00000-0000-4000-8000-000000000004";
const OTHER = "14a00000-0000-4000-8000-000000000001";
const BASE = "https://abcdefghijklmnopqrst.supabase.co";

describe("isOwnAvatarPath", () => {
  it("acepta la ruta que genera la propia aplicación", () => {
    expect(isOwnAvatarPath(buildAvatarPath(USER, "image/webp"), USER)).toBe(true);
    expect(isOwnAvatarPath(`${USER}/foto_1.jpg`, USER)).toBe(true);
  });

  it("rechaza la carpeta de otra persona, subcarpetas y otros tipos", () => {
    expect(isOwnAvatarPath(`${OTHER}/foto.jpg`, USER)).toBe(false);
    expect(isOwnAvatarPath(`${USER}/a/foto.jpg`, USER)).toBe(false);
    expect(isOwnAvatarPath(`${USER}/../${OTHER}/foto.jpg`, USER)).toBe(false);
    expect(isOwnAvatarPath(`${USER}/foto.svg`, USER)).toBe(false);
    expect(isOwnAvatarPath(`${USER}/`, USER)).toBe(false);
  });
});

describe("avatarPublicUrl", () => {
  it("arma la URL pública con la dirección del propio proyecto", () => {
    expect(avatarPublicUrl(`${USER}/foto.png`, BASE)).toBe(
      `${BASE}/storage/v1/object/public/avatars/${USER}/foto.png`,
    );
    expect(avatarPublicUrl(`${USER}/foto.png`, `${BASE}/`)).toBe(
      `${BASE}/storage/v1/object/public/avatars/${USER}/foto.png`,
    );
  });

  it("no muestra lo que no tenga la forma de una ruta propia", () => {
    expect(avatarPublicUrl(null, BASE)).toBeNull();
    // Sin Supabase configurado (modo demostración) no hay de dónde servirla.
    expect(avatarPublicUrl(`${USER}/foto.png`, "")).toBeNull();
    expect(
      avatarPublicUrl(`https://otro.example/storage/v1/object/public/avatars/${USER}/x.jpg`, BASE),
    ).toBeNull();
    expect(avatarPublicUrl("usuario/foto.png", BASE)).toBeNull();
    expect(avatarPublicUrl(`${USER}/foto.gif`, BASE)).toBeNull();
  });
});
