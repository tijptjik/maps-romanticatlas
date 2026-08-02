import { handleAtlasApi } from './worker-api.ts'

export default {
  async fetch(request, env) {
    const apiResponse = await handleAtlasApi(request, env)
    if (apiResponse) return apiResponse
    return env.ASSETS.fetch(request)
  },
}
