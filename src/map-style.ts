import { layers, namedFlavor } from '@protomaps/basemaps'
import type { StyleSpecification } from 'maplibre-gl'

const romanticPaint = layer => {
  if (layer.id === 'background') {
    return { 'background-color': '#efe0bd' }
  }

  if (layer.id === 'earth') {
    return { 'fill-color': '#ead5ab' }
  }

  if (
    (layer.id === 'water' || layer.id.startsWith('water_')) &&
    (layer.type === 'fill' || layer.type === 'line')
  ) {
    return { [layer.type === 'fill' ? 'fill-color' : 'line-color']: '#7d9fa0' }
  }

  if (layer.id === 'landcover' || layer.id.startsWith('landuse_park')) {
    return { 'fill-color': '#a7ae7c' }
  }

  if (layer.id.startsWith('landuse_')) {
    return { 'fill-color': '#d9c997' }
  }

  if (layer.id === 'buildings') {
    return { 'fill-color': '#c99075', 'fill-outline-color': '#9e6657' }
  }

  if (layer.id.startsWith('roads_') && layer.type === 'line') {
    if (layer.id.includes('casing')) {
      return { 'line-color': '#a86f5b' }
    }

    if (layer.id === 'roads_rail') {
      return { 'line-color': '#67504b' }
    }

    return { 'line-color': '#f8edcf' }
  }

  if (layer.id.startsWith('boundaries')) {
    return { 'line-color': '#8d5d52' }
  }

  if (layer.type === 'symbol') {
    return {
      'text-color': '#513c3b',
      'text-halo-color': '#f4e8cb',
      'text-halo-width': 1.5,
    }
  }

  return {}
}

const romanticLayers = layers('hongkong-latest', namedFlavor('light'), { lang: 'en' })
  .filter(
    layer =>
      !layer.id.startsWith('pois') &&
      layer.id !== 'roads_rail' &&
      layer.id !== 'address_label' &&
      !layer.id.startsWith('roads_labels_'),
  )
  .map(layer => ({
    ...layer,
    paint: { ...layer.paint, ...romanticPaint(layer) },
  }))

export const hongKongStyle = {
  version: 8,
  sources: {
    'hongkong-latest': {
      type: 'vector',
      url: '/map-assets/saanseoi/hongkong-latest.json',
    },
  },
  glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
  layers: romanticLayers,
} as unknown as StyleSpecification
