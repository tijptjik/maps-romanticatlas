import type { Map as MapLibreMap } from 'maplibre-gl'

const earthRadiusMetres = 6_371_008.8
const flightRadiusMetres = 1_000
const flightEntryDurationMs = 1_200

type LngLat = [number, number]

const destinationPoint = (
  [longitude, latitude]: LngLat,
  bearingRadians: number,
  distanceMetres: number,
): LngLat => {
  const angularDistance = distanceMetres / earthRadiusMetres
  const latitudeRadians = (latitude * Math.PI) / 180
  const longitudeRadians = (longitude * Math.PI) / 180
  const destinationLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance) +
      Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearingRadians),
  )
  const destinationLongitude =
    longitudeRadians +
    Math.atan2(
      Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
      Math.cos(angularDistance) -
        Math.sin(latitudeRadians) * Math.sin(destinationLatitude),
    )

  return [
    (((destinationLongitude * 180) / Math.PI + 540) % 360) - 180,
    (destinationLatitude * 180) / Math.PI,
  ]
}

// Keep the map north-up while its centre travels clockwise around a geodesic
// circle. Each orbit takes 240 s, and can be paused for map interaction.
export const createMapFlight = (map: MapLibreMap, center: LngLat) => {
  let animationFrame: number | undefined
  let isJoiningFlightPath = false
  let isFlying = false

  const finishJoiningFlightPath = () => {
    isJoiningFlightPath = false
    isFlying = true
    const startedAt = performance.now()

    const fly = (now: number) => {
      if (!isFlying) return

      const elapsedSeconds = (now - startedAt) / 1_000
      const bearingRadians = (elapsedSeconds * 1.5 * Math.PI) / 180
      map.jumpTo({
        center: destinationPoint(center, bearingRadians, flightRadiusMetres),
      })
      animationFrame = window.requestAnimationFrame(fly)
    }

    animationFrame = window.requestAnimationFrame(fly)
  }

  const start = () => {
    if (isJoiningFlightPath || isFlying) return

    isJoiningFlightPath = true
    map.once('moveend', finishJoiningFlightPath)
    map.easeTo({
      center: destinationPoint(center, 0, flightRadiusMetres),
      duration: flightEntryDurationMs,
      essential: true,
    })
  }

  const pause = () => {
    if (animationFrame) window.cancelAnimationFrame(animationFrame)
    animationFrame = undefined
    isFlying = false

    if (isJoiningFlightPath) {
      map.off('moveend', finishJoiningFlightPath)
      map.stop()
      isJoiningFlightPath = false
    }
  }

  return { start, pause }
}
