const express = require('express');
const router = express.Router();
const { prisma } = require('../lib/prisma');
const guestSession = require('../middleware/guest');

/**
 * MODULE 2 — VENDOR & PRODUCT BROWSING
 */

// GET /vendors — list all active (online) vendors
router.get('/vendors', guestSession, async (req, res) => {
  try {
    const { category } = req.query;
    
    const where = {
      onlineStatus: 'online', 
      accountStatus: { in: ['APPROVED', 'ACTIVE'] }
    };

    if (category && category !== 'All') {
      if (category === 'Food') {
        where.businessCategory = {
          notIn: ['Grocery', 'Pharmacy', 'Dairy']
        };
      } else if (category === 'Beverage') {
        where.businessCategory = {
          in: ['Beverages & Shakes', 'Beverage']
        };
      } else {
        where.businessCategory = category;
      }
    }

    const vendors = await prisma.vendor.findMany({
      where,
      select: {
        id: true,
        businessName: true,
        businessCategory: true,
        logoUrl: true,
        bannerUrl: true,
        businessAddress: true,
        latitude: true,
        longitude: true,
        storeDescription: true,
        onlineStatus: true,
        ratingsSummary: true
      }
    });
    const mappedVendors = vendors.map(v => ({
      ...v,
      name: v.businessName,      // Alias for frontend compatibility 
      description: v.storeDescription, // Alias for frontend compatibility
      rating: v.ratingsSummary?.avgRating ? Number(v.ratingsSummary.avgRating).toFixed(1) : '4.5',
      logoUrl: v.logoUrl,
      bannerUrl: v.bannerUrl
    }));

    console.log('[DEBUG] Sending mapped vendors count:', mappedVendors.length);
    if (mappedVendors.length > 0) {
        console.log('[DEBUG] First vendor images:', {
            name: mappedVendors[0].name,
            logo: mappedVendors[0].logoUrl,
            banner: mappedVendors[0].bannerUrl
        });
    }
    res.json({ success: true, vendors: mappedVendors });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

// GET /vendors/:id — vendor details
router.get('/vendors/:id', guestSession, async (req, res) => {
  try {
    const { id } = req.params;
    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: { ratingsSummary: true }
    });

    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    
    const mappedVendor = {
      ...vendor,
      rating: vendor.ratingsSummary?.avgRating ? Number(vendor.ratingsSummary.avgRating).toFixed(1) : '4.5'
    };

    res.json({ success: true, vendor: mappedVendor });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch vendor details' });
  }
});

// GET /vendors/:id/products — all products for a vendor, with add-ons and pricing
router.get('/vendors/:id/products', guestSession, async (req, res) => {
  try {
    const { id } = req.params;
    const products = await prisma.product.findMany({
      where: { 
        vendorId: id, 
        isActive: true, 
        reviewStatus: { equals: 'APPROVED', mode: 'insensitive' }
      },
      include: { 
        addOns: true, 
        images: true,
        categories: true,
        customizationGroups: {
          include: { options: true }
        }
      }
    });
    // 1. Fetch all categories for this vendor to build a name map
    const vendorCategories = await prisma.category.findMany({
      where: { vendorId: id }
    });
    const catMap = vendorCategories.reduce((acc, cat) => ({ ...acc, [cat.id]: cat.name }), {});

    const mappedProducts = products.map(p => {
      // 2. Resolve category name: 
      // Priority 1: Name from the categories relation (most accurate)
      // Priority 2: Mapping the category UUID from catMap
      // Priority 3: The existing category string
      const resolvedCatName = (p.categories && p.categories.length > 0)
        ? p.categories[0].name
        : (catMap[p.category] || p.category || 'Other');

      return {
        ...p,
        category: resolvedCatName,
        image: p.images && p.images.length > 0 ? p.images[0].url : null,
        imageUrl: p.images && p.images.length > 0 ? p.images[0].url : null,
        price: Number(p.basePrice), // Alias for frontend
        addons: p.addOns?.map(a => ({ ...a, price: Number(a.price || 0) })), // Alias and numeric price
        customizationGroups: (p.customizationGroups || []).map(g => ({
          ...g,
          options: (g.options || []).map(o => ({
            ...o,
            priceModifier: Number(o.priceModifier || 0),
            allowQuantity: !!o.allowQuantity,
            freeLimit: o.freeLimit || 0,
            conflicts: o.conflicts || null,
            isAvailable: o.isAvailable !== false,
            displayOrder: o.displayOrder || 0
          }))
        }))
      };
    });
    res.json({ success: true, products: mappedProducts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /products/:id — single product detail with add-ons, pricing tiers, and category/type metadata
router.get('/products/:id', guestSession, async (req, res) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id },
      include: { 
        addOns: true, 
        images: true,
        categories: true,
        customizationGroups: {
          include: { options: true }
        }
      }
    });

    if (!product) return res.status(404).json({ error: 'Product not found' });
    
    const mappedProduct = {
      ...product,
      category: product.categories && product.categories.length > 0 ? product.categories[0].name : (product.category || 'Other'),
      image: product.images && product.images.length > 0 ? `${product.images[0].url}?t=${Date.now()}` : null,
      price: Number(product.basePrice),
      addons: product.addOns?.map(a => ({ ...a, price: Number(a.price || 0) })),
      customizationGroups: (product.customizationGroups || []).map(g => ({
        ...g,
        options: (g.options || []).map(o => ({
          ...o,
          priceModifier: Number(o.priceModifier || 0),
          allowQuantity: !!o.allowQuantity,
          freeLimit: o.freeLimit || 0,
          conflicts: o.conflicts || null,
          isAvailable: o.isAvailable !== false,
          displayOrder: o.displayOrder || 0
        }))
      }))
    };
    res.json({ success: true, product: mappedProduct });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product details' });
  }
});


// GET /vendors/:id/reviews — all feedback for a vendor
router.get('/vendors/:id/reviews', guestSession, async (req, res) => {
  try {
    const { id } = req.params;
    const reviews = await prisma.feedback.findMany({
      where: { order: { vendorId: id } },
      include: {
        customer: { select: { name: true } }
      },
      orderBy: { submittedAt: 'desc' }
    });

    res.json({ success: true, reviews });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// GET /search — search both vendors and products in the database
router.get('/search', guestSession, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.json({ success: true, vendors: [], products: [] });
    }

    const queryStr = q.trim();

    // 1. Search Vendors
    const vendors = await prisma.vendor.findMany({
      where: {
        onlineStatus: 'online',
        accountStatus: { in: ['APPROVED', 'ACTIVE'] },
        OR: [
          { businessName: { contains: queryStr, mode: 'insensitive' } },
          { businessCategory: { contains: queryStr, mode: 'insensitive' } },
          { storeDescription: { contains: queryStr, mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        businessName: true,
        businessCategory: true,
        logoUrl: true,
        bannerUrl: true,
        businessAddress: true,
        ratingsSummary: true
      }
    });

    const mappedVendors = vendors.map(v => ({
      ...v,
      name: v.businessName,
      rating: v.ratingsSummary?.avgRating ? Number(v.ratingsSummary.avgRating).toFixed(1) : '4.5'
    }));

    // 2. Search Products
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        reviewStatus: { equals: 'APPROVED', mode: 'insensitive' },
        vendor: {
          onlineStatus: 'online',
          accountStatus: { in: ['APPROVED', 'ACTIVE'] }
        },
        OR: [
          { name: { contains: queryStr, mode: 'insensitive' } },
          { description: { contains: queryStr, mode: 'insensitive' } },
          { category: { contains: queryStr, mode: 'insensitive' } }
        ]
      },
      include: {
        images: true,
        vendor: {
          select: {
            businessName: true
          }
        }
      },
      take: 20
    });

    const mappedProducts = products.map(p => ({
      ...p,
      image: p.images && p.images.length > 0 ? p.images[0].url : null,
      imageUrl: p.images && p.images.length > 0 ? p.images[0].url : null,
      price: Number(p.basePrice),
      vendorName: p.vendor?.businessName || 'Partner Restaurant'
    }));

    res.json({
      success: true,
      vendors: mappedVendors,
      products: mappedProducts
    });
  } catch (error) {
    console.error('[BROWSING-SEARCH] Error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
