import { describe, expect, it } from "vitest";

import { avatarPathFromPublicUrl, buildAvatarPath, isOwnAvatarPath } from "./avatars";

/**
 * La foto anterior se borra al reemplazarla, y solo si es de verdad la nuestra.
 *
 * `setAvatarAction` traduce el `avatar_url` del perfil a una ruta del bucket
 * para retirarla. Un error aquí es un borrado de lo que no corresponde, así que
 * la traducción se niega ante cualquier cosa que no sea una ruta propia.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BASE = "https://abcd.supabase.co/storage/v1/object/public/avatars";

describe("avatarPathFromPublicUrl", () => {
  it("devuelve la ruta de una foto propia", () => {
    expect(avatarPathFromPublicUrl(`${BASE}/${USER}/foto.jpg`, USER)).toBe(`${USER}/foto.jpg`);
  });

  it("acepta la ruta que la propia aplicación genera", () => {
    const path = buildAvatarPath(USER, "image/webp");
    expect(avatarPathFromPublicUrl(`${BASE}/${path}`, USER)).toBe(path);
  });

  it("no devuelve nada sin foto, con una URL rota o de otro sitio", () => {
    expect(avatarPathFromPublicUrl(null, USER)).toBeNull();
    expect(avatarPathFromPublicUrl("", USER)).toBeNull();
    expect(avatarPathFromPublicUrl("no es una url", USER)).toBeNull();
    expect(avatarPathFromPublicUrl(`https://otro.cl/fotos/${USER}/foto.jpg`, USER)).toBeNull();
  });

  it("no devuelve la foto de otra persona", () => {
    expect(avatarPathFromPublicUrl(`${BASE}/${OTHER}/foto.jpg`, USER)).toBeNull();
  });

  it("no devuelve archivos de otro bucket", () => {
    const url = `https://abcd.supabase.co/storage/v1/object/public/job-images/${USER}/foto.jpg`;
    expect(avatarPathFromPublicUrl(url, USER)).toBeNull();
  });

  it("no se deja llevar fuera de la carpeta", () => {
    expect(avatarPathFromPublicUrl(`${BASE}/${USER}/%2e%2e%2f${OTHER}%2ffoto.jpg`, USER)).toBeNull();
    expect(avatarPathFromPublicUrl(`${BASE}/${USER}/sub/foto.jpg`, USER)).toBeNull();
  });
});

describe("isOwnAvatarPath", () => {
  it("exige la carpeta propia y un archivo", () => {
    expect(isOwnAvatarPath(`${USER}/a.jpg`, USER)).toBe(true);
    expect(isOwnAvatarPath(`${OTHER}/a.jpg`, USER)).toBe(false);
    expect(isOwnAvatarPath(`${USER}/`, USER)).toBe(false);
    expect(isOwnAvatarPath(`a.jpg`, USER)).toBe(false);
  });
});
