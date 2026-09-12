import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Package, 
  Plus, 
  Search, 
  Filter, 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  Edit, 
  Power, 
  RefreshCw, 
  Image as ImageIcon,
  Layers,
  DollarSign,
  TrendingDown
} from 'lucide-react';

import { API_URL as API_BASE, getAssetUrl, getApiHeaders } from '../config/apiConfig';

/**
 * Column geometry for the item table.
 *
 * These widths exist so the table does not resize itself when the search
 * results change. Under the browser default (`table-layout: auto`) each column
 * is sized from its widest cell, so searching "re" and searching "red" produced
 * measurably different layouts: Category swung 36px, Product Name 17px, and the
 * "Current Stock" header wrapped to a second line, changing the header row from
 * 58px to 41px. With `table-layout: fixed` the browser reads these widths and
 * stops measuring content, so geometry is identical for every result set.
 *
 * Percentages total 100. Each one clears the column's real minimum — the header
 * label at `nowrap` plus 32px padding, and for Photo the 40px thumbnail — with
 * the leftover space given to the two long text columns. TABLE_MIN_WIDTH is the
 * sum of those minimums rounded up; below it the existing horizontal scroller
 * takes over rather than letting headers collide.
 */
const COLUMNS = [
  { key: 'photo',    label: 'Photo',         width: '6%' },
  { key: 'sku',      label: 'SKU',           width: '11%' },
  { key: 'name',     label: 'Product Name',  width: '19%' },
  { key: 'category', label: 'Category',      width: '10%' },
  { key: 'unit',     label: 'Unit',          width: '5%' },
  { key: 'stock',    label: 'Current Stock', width: '10%' },
  { key: 'min',      label: 'Min Stock',     width: '8%' },
  { key: 'price',    label: 'Unit Price',    width: '8%' },
  { key: 'ss',       label: 'Stock Status',  width: '10%' },
  { key: 'status',   label: 'Status',        width: '6%' },
  { key: 'actions',  label: 'Actions',       width: '7%', align: 'right' }
];
const TABLE_MIN_WIDTH = 1080;

/** Long values truncate instead of widening their column. */
const CLIP = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

export default function InventoryModule({ token: tokenProp, embedded = false }) {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  // Phase A: units and locations are real master data (backend/repositories/
  // firestore/inventoryUnitsRepository.js, inventoryLocationsRepository.js),
  // no longer a hardcoded list — create them under the Units / Locations tabs.
  const [units, setUnits] = useState([]);
  const [locations, setLocations] = useState([]);
  const [metrics, setMetrics] = useState({
    totalProducts: 0,
    activeProducts: 0,
    lowStockProducts: 0,
    outOfStockProducts: 0
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState({ show: false, message: '', type: 'info' });

  // Filter States
  // `searchTerm` drives the input so typing stays instant; `debouncedSearch` is
  // what actually reaches the server. Only the free-text box is debounced —
  // the category, status and low-stock filters are deliberate single clicks and
  // still apply immediately.
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [onlyLowStock, setOnlyLowStock] = useState(false);

  // Pagination (GET /inventory/products is paginated server-side — Phase A)
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ total: 0, total_pages: 1 });
  const PAGE_SIZE = 100;

  // Changing the query drops you back to page one. This is done DURING RENDER,
  // which is React's sanctioned way to derive state from other state, rather
  // than in an effect. An effect would be too late: effects in the same commit
  // all run together, so the fetch below would fire once with the stale page
  // and again after the reset landed — two requests for one keystroke.
  const queryKey = `${debouncedSearch}|${selectedCategory}|${selectedStatus}|${onlyLowStock}`;
  const [prevQueryKey, setPrevQueryKey] = useState(queryKey);
  if (prevQueryKey !== queryKey) {
    setPrevQueryKey(queryKey);
    setPage(1);
  }

  // Modal States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [formErrors, setFormErrors] = useState({});

  // Form State
  const [formData, setFormData] = useState({
    sku: '',
    name: '',
    category_id: '',
    unit_of_measure: '',
    minimum_stock_level: '0',
    current_stock: '0',
    opening_location_id: '',
    unit_price: '0',
    status: 'Active',
    photo: null
  });
  const [photoPreview, setPhotoPreview] = useState(null);

  // Helper for auth header
  const getAuthHeader = () => {
    const token = tokenProp || localStorage.getItem('adminToken') || localStorage.getItem('token') || localStorage.getItem('staffToken');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const showToast = (message, type = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: '', type: 'info' }), 4000);
  };

  // Fetch Categories
  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/inventory/categories`, { headers: getAuthHeader() });
      if (res.ok) {
        const data = await res.json();
        setCategories(data.categories || []);
      } else {
        console.error('Failed to fetch categories, status:', res.status);
      }
    } catch (err) {
      console.error('Failed to fetch categories:', err);
    }
  }, [tokenProp]);

  // Fetch Units (Phase A master data — see Units tab)
  const fetchUnits = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/inventory/units`, { headers: getAuthHeader() });
      if (res.ok) {
        const data = await res.json();
        setUnits((data.units || []).filter(u => u.is_active !== false));
      }
    } catch (err) {
      console.error('Failed to fetch units:', err);
    }
  }, [tokenProp]);

  // Fetch Locations (needed to record WHERE opening stock is held)
  const fetchLocations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/inventory/locations`, { headers: getAuthHeader() });
      if (res.ok) {
        const data = await res.json();
        setLocations((data.locations || []).filter(l => l.is_active !== false));
      }
    } catch (err) {
      console.error('Failed to fetch locations:', err);
    }
  }, [tokenProp]);

  // Fetch Products & Metrics (paginated — see PAGE_SIZE above)
  // The request currently in flight. A newer search aborts it, so a slow early
  // response can never land after a fast later one and repaint stale rows.
  const inFlightRef = useRef(null);

  const fetchProducts = useCallback(async () => {
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;

    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (debouncedSearch) params.append('search', debouncedSearch);
      if (selectedCategory) params.append('category_id', selectedCategory);
      if (selectedStatus) params.append('status', selectedStatus);
      if (onlyLowStock) params.append('low_stock', 'true');

      const res = await fetch(`${API_BASE}/inventory/products?${params.toString()}`, {
        headers: getAuthHeader(),
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(res.status === 403 ? 'You do not have permission to view items.' : 'Unable to load items right now. Please try again.');
      }

      const data = await res.json();
      if (controller.signal.aborted) return;
      setProducts(data.products || []);
      if (data.metrics) {
        setMetrics(data.metrics);
      }
      setPageInfo({ total: data.total || 0, total_pages: data.total_pages || 1 });
    } catch (err) {
      // An abort is this component superseding its own request, not a failure.
      // It must not surface as an error, and it must not clear the loading flag
      // either — the request that replaced it now owns that.
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
      setError(err.message || 'Unable to load items right now. Please try again.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (inFlightRef.current === controller) inFlightRef.current = null;
    }
  }, [debouncedSearch, selectedCategory, selectedStatus, onlyLowStock, page, tokenProp]);


  useEffect(() => {
    fetchCategories();
    fetchUnits();
    fetchLocations();
  }, [fetchCategories, fetchUnits, fetchLocations]);

  // Typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 250);
    return () => clearTimeout(t);
  }, [searchTerm]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Abort whatever is still in flight when the screen goes away.
  useEffect(() => () => inFlightRef.current?.abort(), []);

  // Two different loading modes, and the distinction is what keeps the layout
  // still. With nothing on screen yet there is nothing to preserve, so the
  // skeleton is right. Once rows exist, emptying the table would collapse the
  // page from thousands of pixels to a few hundred, drop the vertical
  // scrollbar, and hand its width back to the content column — every element
  // on the page shifts. So a refetch leaves the rows where they are.
  const isInitialLoad = loading && products.length === 0;
  const isRefetching = loading && products.length > 0;

  // Open Modal for Create or Edit
  const openModal = (product = null) => {
    setFormErrors({});
    const defaultLocationId = locations.find(l => l.is_default)?.id || locations[0]?.id || '';
    if (product) {
      setEditingProduct(product);
      setFormData({
        sku: product.sku || '',
        name: product.name || '',
        category_id: product.category_id || '',
        unit_of_measure: product.unit_of_measure || units[0]?.code || '',
        minimum_stock_level: product.minimum_stock_level ?? '0',
        current_stock: product.current_stock ?? '0',
        opening_location_id: defaultLocationId,
        unit_price: product.unit_price ?? '0',
        status: product.status || 'Active',
        photo: null
      });
      setPhotoPreview(product.photo_url || null);
    } else {
      setEditingProduct(null);
      setFormData({
        sku: '',
        name: '',
        category_id: categories[0]?.id || '',
        unit_of_measure: units[0]?.code || '',
        minimum_stock_level: '0',
        current_stock: '0',
        opening_location_id: defaultLocationId,
        unit_price: '0',
        status: 'Active',
        photo: null
      });
      setPhotoPreview(null);
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingProduct(null);
    setPhotoPreview(null);
    setFormErrors({});
  };

  // Handle Photo File Select
  const handlePhotoChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        setFormErrors(prev => ({ ...prev, photo: 'File size exceeds 5 MB limit.' }));
        return;
      }
      if (!['image/jpeg', 'image/png', 'image/jpg'].includes(file.type)) {
        setFormErrors(prev => ({ ...prev, photo: 'Only JPG, JPEG, and PNG images are allowed.' }));
        return;
      }

      setFormData(prev => ({ ...prev, photo: file }));
      setPhotoPreview(URL.createObjectURL(file));
      setFormErrors(prev => ({ ...prev, photo: null }));
    }
  };

  // Form Validation
  const validateForm = () => {
    const errors = {};
    if (!formData.sku.trim()) errors.sku = 'SKU is required.';
    if (!formData.name.trim()) errors.name = 'Product Name is required.';
    if (!formData.category_id) errors.category_id = 'Category is required.';
    if (!formData.unit_of_measure) errors.unit_of_measure = 'Unit is required.';

    if (isNaN(parseFloat(formData.minimum_stock_level)) || parseFloat(formData.minimum_stock_level) < 0) {
      errors.minimum_stock_level = 'Minimum stock cannot be negative.';
    }

    if (!editingProduct) {
      const opening = parseFloat(formData.current_stock);
      if (isNaN(opening) || opening < 0) {
        errors.current_stock = 'Initial stock cannot be negative.';
      } else if (opening > 0 && !formData.opening_location_id) {
        errors.opening_location_id = 'Select where this opening stock is held.';
      }
    }

    if (isNaN(parseFloat(formData.unit_price)) || parseFloat(formData.unit_price) < 0) {
      errors.unit_price = 'Unit price cannot be negative.';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Form Submit (Create or Edit)
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;

    setSubmitting(true);
    try {
      const payload = new FormData();
      payload.append('sku', formData.sku);
      payload.append('name', formData.name);
      payload.append('category_id', formData.category_id);
      payload.append('unit_of_measure', formData.unit_of_measure);
      payload.append('minimum_stock_level', formData.minimum_stock_level);
      payload.append('unit_price', formData.unit_price);
      payload.append('status', formData.status);

      // Only set initial current_stock on CREATE — recorded as a real OPENING
      // stock movement server-side (backend/services/inventoryStockService.js),
      // not a raw balance write.
      if (!editingProduct) {
        payload.append('current_stock', formData.current_stock);
        if (parseFloat(formData.current_stock) > 0 && formData.opening_location_id) {
          payload.append('opening_location_id', formData.opening_location_id);
        }
      }

      if (formData.photo) {
        payload.append('photo', formData.photo);
      }

      const url = editingProduct 
        ? `${API_BASE}/inventory/products/${editingProduct.id}`
        : `${API_BASE}/inventory/products`;
      
      const method = editingProduct ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: getAuthHeader(),
        body: payload
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to save product.');
      }

      showToast(editingProduct ? 'Product updated successfully!' : 'New product added successfully!', 'success');
      closeModal();
      fetchProducts();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Soft Deactivate Product
  const handleDeactivate = async (product) => {
    if (!window.confirm(`Are you sure you want to deactivate "${product.name}"?`)) return;

    try {
      const res = await fetch(`${API_BASE}/inventory/products/${product.id}`, {
        method: 'DELETE',
        headers: getAuthHeader()
      });


      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deactivation failed.');

      showToast(`Product "${product.name}" deactivated.`, 'info');
      fetchProducts();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  return (
    <div style={{ padding: embedded ? 0 : '24px', color: '#fff', maxWidth: embedded ? 'none' : '1400px', margin: '0 auto' }}>
      
      {/* Toast Notification */}
      {toast.show && (
        <div style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: 9999,
          padding: '12px 20px',
          borderRadius: '8px',
          background: toast.type === 'error' ? '#ef4444' : toast.type === 'info' ? '#3b82f6' : '#10b981',
          color: '#fff',
          fontWeight: 600,
          boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          {toast.type === 'error' ? <XCircle size={18} /> : <CheckCircle size={18} />}
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-heading, Outfit, sans-serif)' }}>
            <Package color="var(--accent-color, #38bdf8)" size={18} />
            Items
          </h2>
          <p style={{ color: 'var(--text-muted, #94a3b8)', margin: '3px 0 0 0', fontSize: '0.8rem' }}>
            The product master: SKU, category, unit, minimum level, cost and photo. Opening stock is recorded here once; everything after that goes through the stock ledger.
          </p>
        </div>

        <button 
          onClick={() => openModal()}
          className="inv-btn primary"
        >
          <Plus size={15} /> Add Item
        </button>
      </div>

      {/* Dashboard Summary Cards — Overview owns the KPIs; shown only standalone */}
      {!embedded && (
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '16px',
        marginBottom: '24px'
      }}>
        <div className="glass" style={{ padding: '16px 20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 600 }}>Total Products</span>
            <Package size={20} color="#38bdf8" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, marginTop: '8px' }}>{metrics.totalProducts}</div>
        </div>

        <div className="glass" style={{ padding: '16px 20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 600 }}>Active Products</span>
            <CheckCircle size={20} color="#10b981" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, marginTop: '8px', color: '#10b981' }}>{metrics.activeProducts}</div>
        </div>

        <div className="glass" style={{ padding: '16px 20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 600 }}>Low Stock Warning</span>
            <AlertTriangle size={20} color="#f59e0b" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, marginTop: '8px', color: '#f59e0b' }}>{metrics.lowStockProducts}</div>
        </div>

        <div className="glass" style={{ padding: '16px 20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 600 }}>Out of Stock</span>
            <XCircle size={20} color="#ef4444" />
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 800, marginTop: '8px', color: '#ef4444' }}>{metrics.outOfStockProducts}</div>
        </div>
      </div>
      )}

      {/* Toolbar / Filters */}
      <div className="glass" style={{
        padding: '16px',
        borderRadius: '12px',
        marginBottom: '20px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px',
        alignItems: 'center',
        border: '1px solid rgba(255,255,255,0.08)'
      }}>
        {/* Search */}
        <div style={{ flex: '1 1 240px', position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input 
            type="text" 
            placeholder="Search by Product Name or SKU..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '9px 12px 9px 36px',
              borderRadius: '6px',
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: '#fff',
              outline: 'none'
            }}
          />
        </div>

        {/* Category Filter */}
        <select 
          value={selectedCategory} 
          onChange={(e) => setSelectedCategory(e.target.value)}
          style={{
            padding: '9px 12px',
            borderRadius: '6px',
            background: '#0f172a',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#fff',
            outline: 'none'
          }}
        >
          <option value="">All Categories</option>
          {categories.map(c => (
            <option key={c.id} value={c.id}>{c.name} ({c.department})</option>
          ))}
        </select>

        {/* Status Filter */}
        <select 
          value={selectedStatus} 
          onChange={(e) => setSelectedStatus(e.target.value)}
          style={{
            padding: '9px 12px',
            borderRadius: '6px',
            background: '#0f172a',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#fff',
            outline: 'none'
          }}
        >
          <option value="">All Statuses</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>

        {/* Low Stock Toggle */}
        <button 
          onClick={() => setOnlyLowStock(!onlyLowStock)}
          style={{
            padding: '9px 14px',
            borderRadius: '6px',
            background: onlyLowStock ? 'rgba(245, 158, 11, 0.2)' : 'rgba(15, 23, 42, 0.6)',
            border: onlyLowStock ? '1px solid #f59e0b' : '1px solid rgba(255,255,255,0.12)',
            color: onlyLowStock ? '#f59e0b' : '#94a3b8',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontWeight: 600
          }}
        >
          <AlertTriangle size={15} /> Low Stock Only
        </button>

        {/* Refresh */}
        <button 
          onClick={() => fetchProducts()}
          style={{
            padding: '9px',
            borderRadius: '6px',
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#94a3b8',
            cursor: 'pointer'
          }}
          title="Refresh Data"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', color: '#ef4444', padding: '12px', borderRadius: '8px', marginBottom: '20px' }}>
          {error}
        </div>
      )}

      {/* Product Master Table */}
      {/*
        The table, its header and this container stay mounted while a search is
        in flight, and so do the rows themselves — a refetch only dims them.
        Two earlier versions of this got it wrong. Branching on `loading` out
        here destroyed and recreated the whole table on every keystroke. Moving
        that branch into <tbody> stopped the table unmounting but still emptied
        it, which collapsed the page below the viewport, removed the vertical
        scrollbar, and gave its width back to the content column — so every
        element on the page resized on each keystroke. Keeping the rows is what
        actually holds the layout still.
      */}
      <div className="glass" style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: `${TABLE_MIN_WIDTH}px`, tableLayout: 'fixed', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ background: 'rgba(15, 23, 42, 0.8)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  {COLUMNS.map(c => (
                    <th
                      key={c.key}
                      style={{ padding: '12px 16px', width: c.width, whiteSpace: 'nowrap', textAlign: c.align || 'left' }}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody style={{
                // Opacity only. It never participates in layout, so the busy
                // state cannot move anything.
                opacity: isRefetching ? 0.45 : 1,
                pointerEvents: isRefetching ? 'none' : undefined,
                transition: 'opacity 120ms ease'
              }}>
                {isInitialLoad ? (
                  Array.from({ length: 8 }).map((_, r) => (
                    <tr key={`skeleton-${r}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      {Array.from({ length: COLUMNS.length }).map((__, c) => (
                        <td key={c} style={{ padding: '12px 16px' }}>
                          <span className="inv-skel" style={{ width: `${45 + ((r * 7 + c * 13) % 40)}%` }} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : null}
                {!loading && products.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS.length}>
                      <div className="inv-empty">
                        <Package size={22} style={{ opacity: 0.5 }} />
                        <strong>{debouncedSearch || selectedCategory || selectedStatus || onlyLowStock ? 'No items match' : 'No items have been configured'}</strong>
                        <p>{debouncedSearch || selectedCategory || selectedStatus || onlyLowStock ? 'Try a different search or clear the filters.' : 'Add the products the hotel keeps in stock. Each needs a category and a unit of measure.'}</p>
                        <button type="button" className="inv-btn primary sm" onClick={() => openModal()}><Plus size={13} /> Add Item</button>
                      </div>
                    </td>
                  </tr>
                ) : null}
                {products.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '10px 16px' }}>
                      {p.photo_url ? (
                        <img 
                          src={getAssetUrl(p.photo_url)} 
                          alt={p.name} 
                          style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)' }} 
                        />


                      ) : (
                        <div style={{ width: '40px', height: '40px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Package size={18} color="#64748b" />
                        </div>
                      )}
                    </td>
                    <td title={p.sku} style={{ padding: '12px 16px', fontFamily: 'monospace', fontWeight: 600, color: '#38bdf8', ...CLIP }}>{p.sku}</td>
                    <td title={p.name} style={{ padding: '12px 16px', fontWeight: 700, ...CLIP }}>{p.name}</td>
                    <td title={`${p.category_name} — ${p.category_department}`} style={{ padding: '12px 16px', ...CLIP }}>
                      <span style={{ display: 'block', ...CLIP }}>{p.category_name}</span>
                      <span style={{ display: 'block', fontSize: '0.75rem', color: '#64748b', ...CLIP }}>{p.category_department}</span>
                    </td>
                    <td style={{ padding: '12px 16px' }}>{p.unit_of_measure}</td>
                    <td style={{ padding: '12px 16px', fontWeight: 700, fontSize: '1rem' }}>{p.current_stock}</td>
                    <td style={{ padding: '12px 16px', color: '#94a3b8' }}>{p.minimum_stock_level}</td>
                    <td style={{ padding: '12px 16px', fontWeight: 600 }}>₹{p.unit_price}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{
                        padding: '4px 10px',
                        borderRadius: '12px',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        background: p.stock_status === 'Out of Stock' ? 'rgba(239, 68, 68, 0.2)' : p.stock_status === 'Low Stock' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                        color: p.stock_status === 'Out of Stock' ? '#ef4444' : p.stock_status === 'Low Stock' ? '#f59e0b' : '#10b981'
                      }}>
                        {p.stock_status}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{
                        padding: '4px 10px',
                        borderRadius: '12px',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        background: p.status === 'Active' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.15)',
                        color: p.status === 'Active' ? '#10b981' : '#94a3b8'
                      }}>
                        {p.status}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        <button 
                          onClick={() => openModal(p)}
                          style={{ background: 'none', border: 'none', color: '#38bdf8', cursor: 'pointer', padding: '4px' }}
                          title="Edit Product"
                        >
                          <Edit size={16} />
                        </button>
                        {p.status === 'Active' && (
                          <button 
                            onClick={() => handleDeactivate(p)}
                            style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}
                            title="Deactivate Product"
                          >
                            <Power size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        </div>
      </div>

      {pageInfo.total_pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px', alignItems: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.12)', background: page <= 1 ? 'rgba(255,255,255,0.02)' : 'rgba(15,23,42,0.6)', color: page <= 1 ? '#475569' : '#fff', cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
          >
            Previous
          </button>
          <span>Page {page} of {pageInfo.total_pages} ({pageInfo.total} items)</span>
          <button
            disabled={page >= pageInfo.total_pages}
            onClick={() => setPage(p => p + 1)}
            style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.12)', background: page >= pageInfo.total_pages ? 'rgba(255,255,255,0.02)' : 'rgba(15,23,42,0.6)', color: page >= pageInfo.total_pages ? '#475569' : '#fff', cursor: page >= pageInfo.total_pages ? 'not-allowed' : 'pointer' }}
          >
            Next
          </button>
        </div>
      )}

      {/* Add / Edit Product Modal */}
      {isModalOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(2, 6, 23, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: '20px'
        }}>
          <div className="glass" style={{
            background: '#0f172a',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '600px',
            padding: '24px',
            maxHeight: '90vh',
            overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '12px' }}>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0 }}>
                {editingProduct ? 'Edit Product Master' : 'Add New Inventory Product'}
              </h2>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>
                <XCircle size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Photo Upload Section */}
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '6px' }}>
                  Product Photo (JPG/PNG max 5MB)
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  {photoPreview ? (
                    <img src={photoPreview} alt="Preview" style={{ width: '60px', height: '60px', borderRadius: '8px', objectFit: 'cover', border: '1px solid rgba(255,255,255,0.2)' }} />
                  ) : (
                    <div style={{ width: '60px', height: '60px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed rgba(255,255,255,0.2)' }}>
                      <ImageIcon size={24} color="#64748b" />
                    </div>
                  )}
                  <input 
                    type="file" 
                    accept="image/jpeg,image/png,image/jpg" 
                    onChange={handlePhotoChange}
                    style={{ fontSize: '0.85rem', color: '#94a3b8' }}
                  />
                </div>
                {formErrors.photo && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{formErrors.photo}</span>}
              </div>

              {/* SKU & Name */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>SKU *</label>
                  <input 
                    type="text" 
                    placeholder="e.g. VEG-001" 
                    value={formData.sku} 
                    onChange={(e) => setFormData({ ...formData, sku: e.target.value.toUpperCase() })}
                    disabled={!!editingProduct}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: '#020617', border: formErrors.sku ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.12)', color: editingProduct ? '#64748b' : '#38bdf8', fontWeight: 700 }}
                  />
                  {formErrors.sku && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{formErrors.sku}</span>}
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>Product Name *</label>
                  <input 
                    type="text" 
                    placeholder="e.g. Fresh Tomatoes" 
                    value={formData.name} 
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: '#020617', border: formErrors.name ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.12)', color: '#fff' }}
                  />
                  {formErrors.name && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{formErrors.name}</span>}
                </div>
              </div>

              {/* Category & Unit */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>Category *</label>
                  <select 
                    value={formData.category_id} 
                    onChange={(e) => setFormData({ ...formData, category_id: e.target.value })}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: '#020617', border: formErrors.category_id ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.12)', color: '#fff' }}
                  >
                    <option value="">Select Category</option>
                    {categories.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.department})</option>
                    ))}
                  </select>
                  {formErrors.category_id && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{formErrors.category_id}</span>}
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>Unit of Measure *</label>
                  <select 
                    value={formData.unit_of_measure} 
                    onChange={(e) => setFormData({ ...formData, unit_of_measure: e.target.value })}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: '#020617', border: formErrors.unit_of_measure ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.12)', color: '#fff' }}
                  >
                    {units.length === 0 && <option value="">No units yet — create one under Units</option>}
                    {units.map(u => (
                      <option key={u.id} value={u.code}>{u.code} — {u.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Current Stock vs Minimum Stock Level (CRITICAL ADJUSTMENT 3) */}
              <div style={{ display: 'grid', gridTemplateColumns: editingProduct ? '1fr 1fr' : '1fr 1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>
                    {editingProduct ? 'Current Stock (Read-only)' : 'Initial Opening Stock *'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.current_stock}
                    onChange={(e) => setFormData({ ...formData, current_stock: e.target.value })}
                    disabled={!!editingProduct}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: editingProduct ? '#1e293b' : '#020617',
                      border: formErrors.current_stock ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.12)',
                      color: editingProduct ? '#94a3b8' : '#fff',
                      cursor: editingProduct ? 'not-allowed' : 'text'
                    }}
                  />
                  {editingProduct ? (
                    <span style={{ fontSize: '0.7rem', color: '#64748b', display: 'block', marginTop: '2px' }}>
                      Managed via Stock Movements (Adjust / Transfer tab)
                    </span>
                  ) : (
                    formErrors.current_stock && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{formErrors.current_stock}</span>
                  )}
                </div>

                {!editingProduct && (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>Opening Stock Location{parseFloat(formData.current_stock) > 0 ? ' *' : ''}</label>
                    <select
                      value={formData.opening_location_id}
                      onChange={(e) => setFormData({ ...formData, opening_location_id: e.target.value })}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: '#020617', border: formErrors.opening_location_id ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.12)', color: '#fff' }}
                    >
                      <option value="">{locations.length === 0 ? 'No locations yet — create one under Locations' : 'Select location'}</option>
                      {locations.map(l => (
                        <option key={l.id} value={l.id}>{l.name}{l.is_default ? ' (default)' : ''}</option>
                      ))}
                    </select>
                    {formErrors.opening_location_id && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{formErrors.opening_location_id}</span>}
                  </div>
                )}

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>Minimum Stock Warning Level *</label>
                  <input 
                    type="number" 
                    step="0.01"
                    min="0"
                    value={formData.minimum_stock_level} 
                    onChange={(e) => setFormData({ ...formData, minimum_stock_level: e.target.value })}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: '#020617', border: formErrors.minimum_stock_level ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.12)', color: '#fff' }}
                  />
                  {formErrors.minimum_stock_level && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{formErrors.minimum_stock_level}</span>}
                </div>
              </div>

              {/* Unit Price & Status */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>Unit Price (₹) *</label>
                  <input 
                    type="number" 
                    step="0.01"
                    min="0"
                    value={formData.unit_price} 
                    onChange={(e) => setFormData({ ...formData, unit_price: e.target.value })}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: '#020617', border: formErrors.unit_price ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.12)', color: '#fff' }}
                  />
                  {formErrors.unit_price && <span style={{ color: '#ef4444', fontSize: '0.75rem' }}>{formErrors.unit_price}</span>}
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8', marginBottom: '4px' }}>Status</label>
                  <select 
                    value={formData.status} 
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: '#020617', border: '1px solid rgba(255,255,255,0.12)', color: '#fff' }}
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '16px' }}>
                <button 
                  type="button" 
                  onClick={closeModal}
                  style={{ padding: '10px 18px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', fontWeight: 600, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  disabled={submitting}
                  style={{ padding: '10px 20px', borderRadius: '6px', background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', border: 'none', color: '#fff', fontWeight: 700, cursor: submitting ? 'wait' : 'pointer' }}
                >
                  {submitting ? 'Saving...' : editingProduct ? 'Update Product' : 'Save Product'}
                </button>
              </div>

            </form>
          </div>
        </div>
      )}

    </div>
  );
}
