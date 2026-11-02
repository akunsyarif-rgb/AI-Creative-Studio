import "server-only";

/**
 * Deliberate fail-closed boundary. Implement authenticated encryption and key
 * rotation before enabling credential persistence or provider execution.
 */
export async function encryptProviderCredential(_plaintext: string): Promise<string> {
  throw new Error("Credential encryption is not configured. Provider key storage is disabled.");
}

export async function decryptProviderCredential(_ciphertext: string): Promise<string> {
  throw new Error("Credential decryption is not configured. Provider execution is disabled.");
}