# Cloudflare Pages Deployment Guide

## Prerequisites
- Cloudflare account
- GitHub repository pushed
- Railway backend deployed

## Deployment Steps

### 1. Install Cloudflare CLI (optional)
```bash
npm install -g wrangler
wrangler login
```

### 2. Deploy via Dashboard (Recommended)

1. Go to https://dash.cloudflare.com
2. Navigate to: **Workers & Pages** → **Create Application** → **Pages**
3. Click **Connect to Git**
4. Select your repository
5. Configure build settings:

**Build Configuration:**
```
Framework preset: Next.js
Root Directory: apps/web
Build command: npx pnpm build
Build output directory: .next
Node version: 20
```

**Environment Variables:**
```
NEXT_PUBLIC_API_URL=https://<your-railway-app>.up.railway.app/api
```

### 3. Custom Domain (Optional)
1. In Cloudflare Pages → Your Project → Custom Domains
2. Add your domain
3. Cloudflare will auto-configure DNS

## Important Notes

### URLs Structure
- Cloudflare: `https://<project-name>.pages.dev`
- Custom domain: `https://your-domain.com`

### Update Railway CORS
After deployment, update Railway environment variables:
```
ALLOWED_ORIGINS=https://<your-project>.pages.dev
```

Or with custom domain:
```
ALLOWED_ORIGINS=https://your-domain.com
```

## Troubleshooting

### Build Fails
**Issue**: pnpm not found
**Fix**: Set build command to:
```
npx pnpm install && npx pnpm build
```

### 404 on Pages
**Issue**: Static export issues
**Fix**: Your app is configured correctly (client-side rendering), should work out of the box

### API Calls Fail
**Issue**: CORS errors
**Fix**: 
1. Verify `NEXT_PUBLIC_API_URL` is set correctly in Cloudflare
2. Update `ALLOWED_ORIGINS` in Railway to match your Cloudflare URL

## Comparison: Cloudflare vs Vercel

| Feature | Cloudflare Pages | Vercel |
|---------|------------------|--------|
| Bandwidth (Free) | ✅ Unlimited | ⚠️ 100GB/month |
| Builds (Free) | ✅ 500/month | ✅ 6000 minutes |
| Edge Network | ✅ Global CDN | ✅ Global Edge |
| DDoS Protection | ✅ Included | ⚠️ Pro plan |
| Custom Domains | ✅ Free | ✅ Free |
| Build Speed | ⚠️ Medium | ✅ Fast |
| Next.js Support | ✅ Good | ✅ Excellent |
| Analytics | ⚠️ Basic | ✅ Advanced |
| Environment Vars | ✅ Yes | ✅ Yes |
| **Best For** | High traffic | Best DX |

## Recommendation for Your Project

### Choose Cloudflare Pages if:
✅ You expect **many students** accessing sessions simultaneously
✅ You want **zero bandwidth costs**
✅ You prefer Cloudflare's robust infrastructure

### Choose Vercel if:
✅ You want the **fastest deployment** experience
✅ You need **better debugging** and preview deployments
✅ Your traffic will stay under limits

## My Suggestion: Start with Cloudflare Pages
Your project is perfect for Cloudflare because:
1. ✅ Educational use case = potentially high traffic
2. ✅ Client-side rendering (no SSR complexity)
3. ✅ Simple API communication pattern
4. ✅ Unlimited bandwidth = no surprise costs

You can always migrate to Vercel later if needed!
