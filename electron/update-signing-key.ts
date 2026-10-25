/*
 * The public half of the key that signs update manifests.
 *
 * An update is offered only when its manifest verifies against this key, and an
 * installer is launched only when its bytes match that manifest. Replace it with
 * `node scripts/update-signing-key.mjs <file>`; installations built with an older
 * key will not accept manifests signed by the new one.
 */
export const UPDATE_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQoSQF9AOvnykrvGyApXIc5NfhnYIYgTfh58b4whvsXc=
-----END PUBLIC KEY-----
`;
