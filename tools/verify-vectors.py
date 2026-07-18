#!/usr/bin/env python3
"""Independent, cross-language check of the binthere crypto protocol (SPEC.md).

This is a from-scratch Python reimplementation of the key hierarchy from SPEC.md
§2 — PBKDF2 → HKDF → AES-256-GCM wrap/unwrap — run against the *same frozen test
vectors* the JavaScript suite pins in `test/crypto.test.js` (SPEC.md §11). If this
script and the browser code agree on `wk` (wrapped CEK) and `ct` (ciphertext) down
to the byte, the spec is unambiguous enough to be reimplemented without reading the
JS. That is the whole point: the protocol is defined by SPEC.md, not by one codebase.

It uses only the public, synthetic vectors — deterministic all-zero/patterned key
material, never a real paste, fragment, or password. Nothing here is a secret.

Requires: cryptography  (pip install cryptography)
Run:      python tools/verify-vectors.py        # exits non-zero if any vector fails
"""

import base64
import hashlib
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# ── shared inputs, byte-for-byte identical to test/crypto.test.js (SPEC.md §11) ──
F = bytes(range(0x00, 0x20))            # fragment secret: 0x00..0x1f
CEK = bytes(range(0x20, 0x40))          # content key:     0x20..0x3f
IVC = bytes([0x11]) * 12                # content IV
IVW = bytes([0x22]) * 12                # wrap IV
SALT = bytes([0x33]) * 16               # PBKDF2 salt
PLAINTEXT = "binthere vector — zero knowledge ✓".encode("utf-8")
KDF_INFO = b"binthere/v1 kek"

# Expected outputs pinned by the JS suite. If Python derives the same bytes, the
# two independent implementations of SPEC.md agree.
VECTORS = {
    "no password": {
        "use_password": False,
        "password": "",
        "iter": 0,
        "kdf": "hkdf",
        "skdf": "",
        "wk_hex": "07adc270949ba48117e0553655023ae11d326766c13f9dc0"
                  "6b05a69085f5306bd0de61efac880cc08a63ac800daf2a39",
        "ct_hex": "51541cd10292619073e3adbab99d55c8839d57470ec512ba"
                  "5d5edc785ab314316870323b42928ccf3cf019e7d978e063"
                  "97fe19127efa",
    },
    "password 'correct horse'": {
        "use_password": True,
        "password": "correct horse",
        "iter": 310000,
        "kdf": "pbkdf2-hkdf",
        "skdf": base64.urlsafe_b64encode(SALT).rstrip(b"=").decode(),
        "wk_hex": "7e725b2ac4e6e87e6611414186d6ae345f1350d6ab29a669"
                  "d358009ea80c7b7e8b91f5bafd77d958339c236cd3aaa8a1",
        "ct_hex": "51541cd10292619073e3adbab99d55c8839d57470ec512ba"
                  "5d5edc785ab314316870323b42926928351131f61f1f667f"
                  "678bf05521e4",
    },
}


def build_aad(kdf, iter_, skdf):
    """Canonical AAD (SPEC.md §5) — order and newlines are load-bearing."""
    return (
        "binthere/v1\n"
        "alg=A256GCM\n"
        f"kdf={kdf}\n"
        f"iter={iter_}\n"
        "comp=none\n"
        "fmt=plaintext\n"
        "bar=0\n"
        f"ivc={b64url(IVC)}\n"
        f"ivw={b64url(IVW)}\n"
        f"skdf={skdf}\n"
    ).encode("utf-8")


def derive_kek(use_password, password, iter_):
    """KEK = HKDF-SHA256(ikm=F, salt=pw_ikm, info='binthere/v1 kek') — SPEC.md §2.

    pw_ikm is PBKDF2-SHA256(password, SALT, iter) when a password is set, else the
    empty string (⇒ HKDF-Extract falls back to an all-zero salt, per RFC 5869)."""
    pw_ikm = (
        hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), SALT, iter_, dklen=32)
        if use_password
        else b""
    )
    return HKDF(algorithm=SHA256(), length=32, salt=pw_ikm, info=KDF_INFO).derive(F)


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def main() -> int:
    failures = 0
    for name, v in VECTORS.items():
        aad = build_aad(v["kdf"], v["iter"], v["skdf"])
        kek = derive_kek(v["use_password"], v["password"], v["iter"])

        # Wrap the CEK under the KEK, and encrypt the plaintext under the CEK.
        wk = AESGCM(kek).encrypt(IVW, CEK, aad)
        ct = AESGCM(CEK).encrypt(IVC, PLAINTEXT, aad)

        # And prove the inverse: unwrap → decrypt recovers the plaintext.
        cek_back = AESGCM(kek).decrypt(IVW, wk, aad)
        pt_back = AESGCM(cek_back).decrypt(IVC, bytes.fromhex(v["ct_hex"]), aad)

        ok = (
            wk.hex() == v["wk_hex"]
            and ct.hex() == v["ct_hex"]
            and cek_back == CEK
            and pt_back == PLAINTEXT
        )
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        if not ok:
            failures += 1
            if wk.hex() != v["wk_hex"]:
                print(f"       wk  expected {v['wk_hex']}\n           got      {wk.hex()}")
            if ct.hex() != v["ct_hex"]:
                print(f"       ct  expected {v['ct_hex']}\n           got      {ct.hex()}")

    print()
    if failures:
        print(f"{failures} vector(s) FAILED — Python and the SPEC disagree.")
        return 1
    print("All vectors match the SPEC. The two implementations agree byte-for-byte.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
