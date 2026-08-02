import { createFalClient as createSdkClient } from '@fal-ai/client'

/**
 * Creates a server-only client for invoking Fal model endpoints.
 * Do not import this module from src/main.js or browser-delivered code.
 */
export const createFalClient = ({ apiKey = process.env.FAL_KEY } = {}) => {
  if (!apiKey) {
    throw new Error('Missing FAL_KEY. Set it in the server environment before calling Fal.')
  }

  const client = createSdkClient({ credentials: apiKey })

  return {
    /** Submit work to any Fal endpoint and wait for its queued result. */
    async subscribe(modelId, input, options = {}) {
      return client.subscribe(modelId, { input, ...options })
    },

    /** Submit a direct Fal request for endpoints that do not require queueing. */
    async run(modelId, input) {
      return client.run(modelId, { input })
    },
  }
}
