/** AAD context binding a ciphertext to its owner and provider. Pure, safe to import anywhere. */
export function credentialContext(ownerId: string, providerId: string): string {
  return `provider-credential:${ownerId}:${providerId}`;
}
