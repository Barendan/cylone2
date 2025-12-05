'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet.markercluster';
import type { EnhancedCityResponse } from '@/lib/geography/cityTypes';
import type { YelpBusiness } from '@/lib/yelp/search';
import type { YelpTestResult } from './index';

// Fix for default markers in Leaflet
delete (L.Icon.Default.prototype as { _getIconUrl?: string })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

interface CityMapCoreProps {
  cityData: EnhancedCityResponse | null;
  showBuffered: boolean;
  showH3Grid: boolean;
  showHexagonNumbers: boolean;
  showRestaurants?: boolean;
  restaurants?: YelpBusiness[];
  restaurantData?: YelpTestResult | null;
  onMapReady: (map: L.Map) => void;
}

export default function CityMapCore({ 
  cityData, 
  showBuffered, 
  showH3Grid, 
  showHexagonNumbers,
  showRestaurants = false,
  restaurants = [],
  restaurantData = null,
  onMapReady 
}: CityMapCoreProps) {
  const mapRef = useRef<L.Map | null>(null);
  const cityLayerRef = useRef<L.GeoJSON | null>(null);
  const bufferedLayerRef = useRef<L.GeoJSON | null>(null);
  const h3GridLayerRef = useRef<L.LayerGroup | null>(null);
  const restaurantLayerRef = useRef<L.MarkerClusterGroup | null>(null);

  // Initialize map with performance optimizations
  useEffect(() => {
    if (!mapRef.current) {
      // Ensure the map container exists and has dimensions
      const mapContainer = document.getElementById('map');
      if (!mapContainer) {
        console.error('❌ Map container not found');
        return;
      }
      
      const map = L.map('map', {
        preferCanvas: true, // Better performance for many future restaurant markers
        center: [20, 0],
        zoom: 2,
        zoomControl: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        attributionControl: true
      });

      // Add OSM tile layer
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18
      }).addTo(map);

      mapRef.current = map;
      onMapReady(map);
    }

    // Cleanup function
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [onMapReady]);

  // Update city data with enhanced styling and layers
  useEffect(() => {
    if (!mapRef.current || !cityData) return;

    const map = mapRef.current;

    // Remove existing layers
    if (cityLayerRef.current) {
      map.removeLayer(cityLayerRef.current);
    }
    if (bufferedLayerRef.current) {
      map.removeLayer(bufferedLayerRef.current);
    }
    if (h3GridLayerRef.current) {
      map.removeLayer(h3GridLayerRef.current);
    }

    // Add original city boundary layer
    const cityLayer = L.geoJSON(cityData.geojson, {
      style: {
        color: '#2563eb',
        weight: 3,
        opacity: 0.8,
        fillColor: '#3b82f6',
        fillOpacity: 0.15
      }
    });

    cityLayer.addTo(map);
    cityLayerRef.current = cityLayer;

    // Add buffered polygon layer
    if (showBuffered) {
      const bufferedLayer = L.geoJSON(cityData.buffered_polygon, {
        style: {
          color: '#7c3aed',
          weight: 2,
          opacity: 0.6,
          fillColor: '#a855f7',
          fillOpacity: 0.1
        }
      });

      bufferedLayer.addTo(map);
      bufferedLayerRef.current = bufferedLayer;
    }

    // Add H3 grid layer
    if (showH3Grid && cityData.h3_grid.length > 0) {
      const h3GridLayer = L.layerGroup();
      
      // Import h3 dynamically to avoid SSR issues
      const h3 = require('h3-js');
      
      // Create a Set of cached hexagon IDs for quick lookup
      const cachedHexagonIds = new Set<string>();
      if (restaurantData?.results) {
        restaurantData.results.forEach(result => {
          if (result.status === 'fetched' || result.status === 'dense') {
            cachedHexagonIds.add(result.h3Id);
          }
        });
      }
      
      try {
        let renderedCount = 0;
        
        cityData.h3_grid.forEach((h3Index, i) => {
          try {
            const boundary = h3.cellToBoundary(h3Index, true);
            
            // Validate boundary coordinates
            if (!boundary || !Array.isArray(boundary) || boundary.length < 3) {
              return;
            }
            
            // Convert H3 boundary to Leaflet polygon coordinates
            // H3 returns [lng, lat] but Leaflet expects [lat, lng]
            const polygonCoords: [number, number][] = boundary.map((coord: number[]) => [coord[1], coord[0]]); // [lat, lng] for Leaflet
            
            // Check if this hexagon is cached
            const isCached = cachedHexagonIds.has(h3Index);
            
            // Apply gold outline for cached hexagons, green for others
            const polygon = L.polygon(polygonCoords, {
              color: isCached ? '#d97706' : '#059669', // Gold for cached, green for uncached
              weight: isCached ? 3 : 2, // Slightly thicker for cached hexagons
              opacity: 0.8,
              fillColor: isCached ? '#fbbf24' : '#10b981', // Gold tint for cached, green for uncached
              fillOpacity: 0.15
            });
            
            // Add hexagon number label (conditionally)
            if (showHexagonNumbers) {
              const center = polygon.getBounds().getCenter();
              const label = L.divIcon({
                className: 'hexagon-label',
                html: `<div style="
                  background: rgba(255, 255, 255, 0.95);
                  border: 2px solid #059669;
                  border-radius: 50%;
                  width: 28px;
                  height: 28px;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  font-weight: bold;
                  font-size: 11px;
                  color: #059669;
                  text-shadow: 1px 1px 2px rgba(255, 255, 255, 0.9);
                  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
                  font-family: 'Courier New', monospace;
                ">${i}</div>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
              });
              
              const labelMarker = L.marker(center, { icon: label });
              h3GridLayer.addLayer(labelMarker);
            }
            
            h3GridLayer.addLayer(polygon);
            renderedCount++;
          } catch (hexError) {
            console.error(`Error rendering hexagon ${i}:`, hexError);
          }
        });
        
        if (renderedCount > 0) {
          h3GridLayer.addTo(map);
          h3GridLayerRef.current = h3GridLayer;
          
          // Force a map refresh to ensure hexagons are visible
          map.invalidateSize();
        }
        
      } catch (error) {
        console.error('Error rendering H3 grid:', error);
      }
    }

    // Fit bounds to city with padding
    const bounds = cityLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, {
        padding: [24, 24],
        maxZoom: 18
      });
    }
  }, [cityData, showBuffered, showH3Grid, showHexagonNumbers, restaurantData]);

  // Restaurant layer management
  useEffect(() => {
    if (!mapRef.current || !showRestaurants || !restaurants || restaurants.length === 0) {
      // Remove existing restaurant layer if conditions not met
      if (restaurantLayerRef.current && mapRef.current) {
        mapRef.current.removeLayer(restaurantLayerRef.current);
        restaurantLayerRef.current.clearLayers();
        restaurantLayerRef.current = null;
      }
      return;
    }

    const map = mapRef.current;
    
    // CRITICAL: Store current map view BEFORE doing anything
    const currentCenter = map.getCenter();
    const currentZoom = map.getZoom();
    
    // Remove existing layer
    if (restaurantLayerRef.current) {
      map.removeLayer(restaurantLayerRef.current);
      restaurantLayerRef.current.clearLayers();
    }

    // Create cluster group with our styling - disable auto-zoom behavior
    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 50, // Reasonable clustering distance
      zoomToBoundsOnClick: true, // Only zoom when clicking cluster, not on add
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: 18
    });

    // Add each restaurant as a marker to the cluster group FIRST (before adding to map)
    let validRestaurants = 0;
    const markers: L.Marker[] = [];
    
    restaurants.forEach((restaurant) => {
      const { latitude, longitude } = restaurant.coordinates;
      
      // Validate coordinates
      if (!latitude || !longitude || 
          latitude < -90 || latitude > 90 || 
          longitude < -180 || longitude > 180 ||
          isNaN(latitude) || isNaN(longitude)) {
        return;
      }

      try {
        const marker = L.marker([latitude, longitude])
          .bindPopup(`
            <div style="min-width: 200px">
              <strong>${restaurant.name}</strong><br>
              <span style="color: #f59e0b">★</span> ${restaurant.rating} (${restaurant.review_count} reviews)<br>
              ${restaurant.categories?.map(c => c.title).join(', ') || 'Restaurant'}<br>
              <small>${restaurant.location?.address1 || ''}</small>
            </div>
          `);
        
        markers.push(marker);
        clusterGroup.addLayer(marker);
        validRestaurants++;
      } catch (error) {
        console.error(`Error creating marker for ${restaurant.name}:`, error);
      }
    });

    if (validRestaurants > 0) {
      // Temporarily disable map movement events
      map.dragging.disable();
      map.touchZoom.disable();
      map.doubleClickZoom.disable();
      map.scrollWheelZoom.disable();
      map.boxZoom.disable();
      map.keyboard.disable();
      
      // Add cluster group to map
      map.addLayer(clusterGroup);
      restaurantLayerRef.current = clusterGroup;
      
      // IMMEDIATELY restore the previous view (this prevents auto-zoom)
      map.setView(currentCenter, currentZoom, { animate: false });
      
      // Re-enable map interactions
      map.dragging.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
      map.scrollWheelZoom.enable();
      map.boxZoom.enable();
      map.keyboard.enable();
    }

  }, [showRestaurants, restaurants]);

  return null; // This component doesn't render anything visible
}
