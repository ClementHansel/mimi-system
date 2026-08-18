'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { formatMoney } from '@/lib/formatters';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Drawer } from '@/components/ui/Drawer';
import { Checkbox } from '@/components/ui/Checkbox';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { QtyInput } from '@/components/ui/QtyInput';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { useApiList } from './useApiList';
import type {
  Item,
  ItemCategory,
  Unit,
  Location,
  StorageArea,
  StorageAreaType,
  Product,
  Recipe,
  RecipeLine,
} from './types';

/**
 * F10 admin — Master Data (CONTRACTS §4.4 item, §4.5 product/recipe, §4.3
 * location + storage areas D-15). Four sub-tabs under one `Tabs` shell rather
 * than four routes — this is a laptop back-office surface where switching
 * "which master list am I looking at" is a tab flick, not a navigation.
 */
function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// ── Items ────────────────────────────────────────────────────────────────
function ItemsSection({ categories, units }: { categories: ItemCategory[]; units: Unit[] }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<Item>('/items', { q, page, pageSize });
  const [editing, setEditing] = useState<Item | null | 'new'>(null);

  const columns: DataTableColumn<Item>[] = [
    { key: 'sku', header: t('admin.masterData.items.columnSku'), sortable: true },
    { key: 'name', header: t('admin.masterData.items.columnName'), sortable: true },
    {
      key: 'categoryName',
      header: t('admin.masterData.items.columnCategory'),
      render: (r) => r.categoryName ?? '—',
    },
    {
      key: 'baseUnit',
      header: t('admin.masterData.items.columnUnit'),
      render: (r) => r.baseUnit.code,
    },
    { key: 'storageType', header: t('admin.masterData.items.columnStorageType') },
    {
      key: 'isSellable',
      header: t('admin.masterData.items.columnSellable'),
      render: (r) => (r.isSellable ? t('common.yes') : t('common.no')),
    },
    {
      key: 'isActive',
      header: t('admin.masterData.items.columnStatus'),
      render: (r) => (r.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Input
          placeholder={t('admin.masterData.items.searchPlaceholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          wrapperClassName="w-72"
        />
        <PermissionGate permission="item.manage">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            {t('admin.masterData.items.createButton')}
          </Button>
        </PermissionGate>
      </div>
      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        onRowClick={can('item.manage') ? (r) => setEditing(r) : undefined}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />
      {editing && (
        <ItemFormModal
          item={editing === 'new' ? null : editing}
          categories={categories}
          units={units}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ItemFormModal({
  item,
  categories,
  units,
  onClose,
  onSaved,
}: {
  item: Item | null;
  categories: ItemCategory[];
  units: Unit[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [sku, setSku] = useState(item?.sku ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [baseUnitId, setBaseUnitId] = useState(item?.baseUnit.id ?? units[0]?.id ?? '');
  const [storageType, setStorageType] = useState<Item['storageType']>(item?.storageType ?? 'dry');
  const [isSellable, setIsSellable] = useState(item?.isSellable ?? false);
  const [shelfLifeDays, setShelfLifeDays] = useState(item?.shelfLifeDays?.toString() ?? '');
  const [barcode, setBarcode] = useState(item?.barcode ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    const body = {
      sku,
      name,
      categoryId: categoryId || undefined,
      baseUnitId,
      storageType,
      isSellable,
      shelfLifeDays: shelfLifeDays ? Number(shelfLifeDays) : undefined,
      barcode: barcode || undefined,
    };
    try {
      if (item) await api.patch(`/items/${item.id}`, body);
      else await api.post('/items', body);
      toast({
        title: t(
          item ? 'admin.masterData.items.updateSuccess' : 'admin.masterData.items.createSuccess',
        ),
        variant: 'success',
      });
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t(item ? 'admin.masterData.items.editTitle' : 'admin.masterData.items.createTitle')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} disabled={!sku || !name || !baseUnitId}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {error && <p className="col-span-2 text-sm text-danger-600">{error}</p>}
        <Input
          label={t('admin.masterData.items.sku')}
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          required
        />
        <Input
          label={t('admin.masterData.items.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Select
          label={t('admin.masterData.items.category')}
          value={categoryId}
          onValueChange={setCategoryId}
          placeholder={t('common.selectPlaceholder')}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          label={t('admin.masterData.items.baseUnit')}
          value={baseUnitId}
          onValueChange={setBaseUnitId}
          options={units.map((u) => ({ value: u.id, label: `${u.name} (${u.code})` }))}
        />
        <Select
          label={t('admin.masterData.items.storageType')}
          value={storageType}
          onValueChange={(v) => setStorageType(v as Item['storageType'])}
          options={[
            { value: 'frozen', label: t('admin.masterData.items.storageFrozen') },
            { value: 'chilled', label: t('admin.masterData.items.storageChilled') },
            { value: 'dry', label: t('admin.masterData.items.storageDry') },
          ]}
        />
        <Input
          label={t('admin.masterData.items.shelfLifeDays')}
          inputMode="numeric"
          value={shelfLifeDays}
          onChange={(e) => setShelfLifeDays(e.target.value.replace(/\D/g, ''))}
        />
        <Input
          label={t('admin.masterData.items.barcode')}
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
        />
        <div className="col-span-2">
          <Checkbox
            label={t('admin.masterData.items.isSellable')}
            checked={isSellable}
            onCheckedChange={setIsSellable}
          />
        </div>
      </div>
    </Modal>
  );
}

// ── Categories & Units ──────────────────────────────────────────────────
function CategoriesUnitsSection({
  categories,
  units,
  onReload,
}: {
  categories: ItemCategory[];
  units: Unit[];
  onReload: () => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [newCategory, setNewCategory] = useState('');
  const [newCategoryParent, setNewCategoryParent] = useState('');
  const [newUnitCode, setNewUnitCode] = useState('');
  const [newUnitName, setNewUnitName] = useState('');
  const [busy, setBusy] = useState(false);

  async function addCategory() {
    setBusy(true);
    try {
      await api.post('/items/categories', {
        name: newCategory,
        parentId: newCategoryParent || undefined,
      });
      setNewCategory('');
      setNewCategoryParent('');
      toast({ title: t('admin.masterData.categories.createSuccess'), variant: 'success' });
      onReload();
    } catch (err) {
      toast({ title: errMsg(err, t('auth.genericError')), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function addUnit() {
    setBusy(true);
    try {
      await api.post('/units', { code: newUnitCode, name: newUnitName });
      setNewUnitCode('');
      setNewUnitName('');
      toast({ title: t('admin.masterData.units.createSuccess'), variant: 'success' });
      onReload();
    } catch (err) {
      toast({ title: errMsg(err, t('auth.genericError')), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-2 gap-6">
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-text-primary">{t('admin.masterData.categories.title')}</h3>
        <ul className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm">
          {categories.map((c) => (
            <li key={c.id} className="px-2 py-1">
              {c.name}
            </li>
          ))}
        </ul>
        {can('item.manage') && (
          <div className="flex items-end gap-2">
            <Input
              label={t('admin.masterData.categories.name')}
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              wrapperClassName="flex-1"
            />
            <Select
              label={t('admin.masterData.categories.parent')}
              value={newCategoryParent}
              onValueChange={setNewCategoryParent}
              placeholder={t('admin.masterData.categories.noParent')}
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
              wrapperClassName="flex-1"
            />
            <Button size="sm" onClick={addCategory} loading={busy} disabled={!newCategory}>
              {t('admin.masterData.categories.createButton')}
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-text-primary">{t('admin.masterData.units.title')}</h3>
        <ul className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm">
          {units.map((u) => (
            <li key={u.id} className="px-2 py-1">
              {u.name} ({u.code})
            </li>
          ))}
        </ul>
        <PermissionGate permission="unit.manage">
          <div className="flex items-end gap-2">
            <Input
              label={t('admin.masterData.units.code')}
              value={newUnitCode}
              onChange={(e) => setNewUnitCode(e.target.value)}
              wrapperClassName="w-24"
            />
            <Input
              label={t('admin.masterData.units.name')}
              value={newUnitName}
              onChange={(e) => setNewUnitName(e.target.value)}
              wrapperClassName="flex-1"
            />
            <Button
              size="sm"
              onClick={addUnit}
              loading={busy}
              disabled={!newUnitCode || !newUnitName}
            >
              {t('admin.masterData.units.createButton')}
            </Button>
          </div>
        </PermissionGate>
      </div>
    </div>
  );
}

// ── Products & Recipes ──────────────────────────────────────────────────
function ProductsSection({ items, units }: { items: Item[]; units: Unit[] }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<Product>('/products', { q, page, pageSize });
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [recipeFor, setRecipeFor] = useState<Product | null>(null);

  const columns: DataTableColumn<Product>[] = [
    { key: 'code', header: t('admin.masterData.products.columnCode'), sortable: true },
    { key: 'name', header: t('admin.masterData.products.columnName'), sortable: true },
    { key: 'category', header: t('admin.masterData.products.columnCategory') },
    {
      key: 'price',
      header: t('admin.masterData.products.columnPrice'),
      align: 'right',
      render: (r) => formatMoney(r.price),
    },
    {
      key: 'hasRecipe',
      header: t('admin.masterData.products.columnHasRecipe'),
      render: (r) => (r.hasRecipe ? t('common.yes') : t('common.no')),
    },
    {
      key: 'isActive',
      header: t('admin.masterData.products.columnStatus'),
      render: (r) => (r.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      render: (r) =>
        can('recipe.manage') ? (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setRecipeFor(r);
            }}
          >
            {t('admin.masterData.products.editRecipe')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Input
          placeholder={t('admin.masterData.products.searchPlaceholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          wrapperClassName="w-72"
        />
        <PermissionGate permission="product.manage">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            {t('admin.masterData.products.createButton')}
          </Button>
        </PermissionGate>
      </div>
      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        onRowClick={can('product.manage') ? (r) => setEditing(r) : undefined}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />
      {editing && (
        <ProductFormModal
          product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {recipeFor && (
        <RecipeModal
          product={recipeFor}
          items={items}
          units={units}
          onClose={() => setRecipeFor(null)}
          onSaved={() => {
            setRecipeFor(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ProductFormModal({
  product,
  onClose,
  onSaved,
}: {
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState(product?.code ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [price, setPrice] = useState(product?.price ?? null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = { code, name, category, price: price ?? '0.00' };
      if (product) await api.patch(`/products/${product.id}`, body);
      else await api.post('/products', body);
      toast({
        title: t(
          product
            ? 'admin.masterData.products.updateSuccess'
            : 'admin.masterData.products.createSuccess',
        ),
        variant: 'success',
      });
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t(
        product ? 'admin.masterData.products.editTitle' : 'admin.masterData.products.createTitle',
      )}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} disabled={!code || !name}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <Input
          label={t('admin.masterData.products.code')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        <Input
          label={t('admin.masterData.products.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          label={t('admin.masterData.products.category')}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <MoneyInput
          label={t('admin.masterData.products.price')}
          value={price}
          onChange={setPrice}
        />
      </div>
    </Modal>
  );
}

function RecipeModal({
  product,
  items,
  units,
  onClose,
  onSaved,
}: {
  product: Product;
  items: Item[];
  units: Unit[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [yieldQty, setYieldQty] = useState<string | null>('1');
  const [lines, setLines] = useState<RecipeLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get<Recipe>(`/products/${product.id}/recipe`)
      .then((r) => {
        setYieldQty(r.yieldQty);
        setLines(r.lines);
      })
      .catch(() => {
        /* no recipe yet — start blank */
      })
      .finally(() => setLoading(false));
  }, [product.id]);

  function addLine() {
    const first = items[0];
    if (!first) return;
    setLines((ls) => [
      ...ls,
      {
        itemId: first.id,
        itemName: first.name,
        qty: '0',
        unitId: first.baseUnit.id,
        unitCode: first.baseUnit.code,
      },
    ]);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.put(`/products/${product.id}/recipe`, {
        yieldQty: yieldQty ?? '1',
        lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitId: l.unitId })),
      });
      toast({ title: t('admin.masterData.products.recipeSuccess'), variant: 'success' });
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('admin.masterData.products.recipeTitle', { name: product.name })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting || loading}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <QtyInput
          label={t('admin.masterData.products.yieldQty')}
          value={yieldQty}
          onChange={setYieldQty}
        />
        <div className="flex flex-col gap-2">
          {lines.map((line, idx) => (
            <div key={idx} className="flex items-end gap-2">
              <Select
                label={idx === 0 ? t('admin.masterData.products.recipeItem') : undefined}
                value={line.itemId}
                onValueChange={(v) =>
                  setLines((ls) =>
                    ls.map((l, i) =>
                      i === idx
                        ? {
                            ...l,
                            itemId: v,
                            itemName: items.find((it) => it.id === v)?.name ?? l.itemName,
                          }
                        : l,
                    ),
                  )
                }
                options={items.map((it) => ({ value: it.id, label: it.name }))}
                wrapperClassName="flex-1"
              />
              <QtyInput
                label={idx === 0 ? t('admin.masterData.products.recipeQty') : undefined}
                value={line.qty}
                onChange={(v) =>
                  setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, qty: v ?? '0' } : l)))
                }
                unitCode={line.unitCode}
                wrapperClassName="w-40"
              />
              <Select
                label={idx === 0 ? t('admin.masterData.products.recipeUnit') : undefined}
                value={line.unitId}
                onValueChange={(v) =>
                  setLines((ls) =>
                    ls.map((l, i) =>
                      i === idx
                        ? {
                            ...l,
                            unitId: v,
                            unitCode: units.find((u) => u.id === v)?.code ?? l.unitCode,
                          }
                        : l,
                    ),
                  )
                }
                options={units.map((u) => ({ value: u.id, label: u.code }))}
                wrapperClassName="w-28"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
              >
                {t('admin.masterData.products.removeLine')}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={addLine}
            className="self-start"
            leftIcon={<Plus className="size-4" />}
          >
            {t('admin.masterData.products.addLine')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Locations & Storage Areas ────────────────────────────────────────────
function LocationsSection() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<Location>('/locations', { page, pageSize });
  const [editing, setEditing] = useState<Location | null | 'new'>(null);
  const [areasFor, setAreasFor] = useState<Location | null>(null);

  const columns: DataTableColumn<Location>[] = [
    { key: 'code', header: t('admin.masterData.locations.columnCode'), sortable: true },
    { key: 'name', header: t('admin.masterData.locations.columnName'), sortable: true },
    {
      key: 'type',
      header: t('admin.masterData.locations.columnType'),
      render: (r) =>
        t(
          r.type === 'warehouse'
            ? 'admin.masterData.locations.typeWarehouse'
            : 'admin.masterData.locations.typeOutlet',
        ),
    },
    { key: 'city', header: t('admin.masterData.locations.columnCity') },
    {
      key: 'storageAreaCount',
      header: t('admin.masterData.locations.columnAreas'),
      align: 'right',
    },
    {
      key: 'isActive',
      header: t('admin.masterData.locations.columnStatus'),
      render: (r) => (r.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      render: (r) => (
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            setAreasFor(r);
          }}
        >
          {t('admin.masterData.locations.storageAreas')}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <PermissionGate permission="location.manage">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            {t('admin.masterData.locations.createButton')}
          </Button>
        </PermissionGate>
      </div>
      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        onRowClick={can('location.manage') ? (r) => setEditing(r) : undefined}
        onPageChange={setPage}
        onPageSizeChange={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />
      {editing && (
        <LocationFormModal
          location={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {areasFor && (
        <StorageAreasDrawer
          location={areasFor}
          onClose={() => {
            setAreasFor(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function LocationFormModal({
  location,
  onClose,
  onSaved,
}: {
  location: Location | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState(location?.code ?? '');
  const [name, setName] = useState(location?.name ?? '');
  const [type, setType] = useState<Location['type']>(location?.type ?? 'outlet');
  const [city, setCity] = useState(location?.city ?? '');
  const [address, setAddress] = useState(location?.address ?? '');
  const [phone, setPhone] = useState(location?.phone ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    const body = {
      code,
      name,
      type,
      city,
      address: address || undefined,
      phone: phone || undefined,
    };
    try {
      if (location) await api.patch(`/locations/${location.id}`, body);
      else await api.post('/locations', body);
      toast({
        title: t(
          location
            ? 'admin.masterData.locations.updateSuccess'
            : 'admin.masterData.locations.createSuccess',
        ),
        variant: 'success',
      });
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t(
        location
          ? 'admin.masterData.locations.editTitle'
          : 'admin.masterData.locations.createTitle',
      )}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} disabled={!code || !name || !city}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {error && <p className="col-span-2 text-sm text-danger-600">{error}</p>}
        <Input
          label={t('admin.masterData.locations.code')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        <Input
          label={t('admin.masterData.locations.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Select
          label={t('admin.masterData.locations.type')}
          value={type}
          onValueChange={(v) => setType(v as Location['type'])}
          options={[
            { value: 'warehouse', label: t('admin.masterData.locations.typeWarehouse') },
            { value: 'outlet', label: t('admin.masterData.locations.typeOutlet') },
          ]}
        />
        <Input
          label={t('admin.masterData.locations.city')}
          value={city}
          onChange={(e) => setCity(e.target.value)}
          required
        />
        <Input
          label={t('admin.masterData.locations.address')}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <Input
          label={t('admin.masterData.locations.phone')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
    </Modal>
  );
}

const STORAGE_AREA_TYPES: { value: StorageAreaType; labelKey: string }[] = [
  { value: 'freezer', labelKey: 'admin.masterData.locations.areaTypeFreezer' },
  { value: 'chiller', labelKey: 'admin.masterData.locations.areaTypeChiller' },
  { value: 'dry_store', labelKey: 'admin.masterData.locations.areaTypeDryStore' },
  { value: 'display', labelKey: 'admin.masterData.locations.areaTypeDisplay' },
  { value: 'kitchen_line', labelKey: 'admin.masterData.locations.areaTypeKitchenLine' },
];

function StorageAreasDrawer({ location, onClose }: { location: Location; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<StorageAreaType>('dry_store');
  const [busy, setBusy] = useState(false);

  function reload() {
    setLoading(true);
    api
      .get<StorageArea[]>(`/locations/${location.id}/storage-areas`)
      .then(setAreas)
      .finally(() => setLoading(false));
  }
  useEffect(reload, [location.id]);

  async function addArea() {
    setBusy(true);
    try {
      await api.post(`/locations/${location.id}/storage-areas`, { code, name, type });
      setCode('');
      setName('');
      toast({ title: t('admin.masterData.locations.areaCreateSuccess'), variant: 'success' });
      reload();
    } catch (err) {
      toast({ title: errMsg(err, t('auth.genericError')), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(area: StorageArea) {
    try {
      await api.patch(`/locations/${location.id}/storage-areas/${area.id}`, {
        isActive: !area.isActive,
      });
      reload();
    } catch (err) {
      toast({
        title: errMsg(err, t('admin.masterData.locations.areaHasStock')),
        variant: 'danger',
      });
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${t('admin.masterData.locations.storageAreas')} — ${location.name}`}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-1">
          {!loading &&
            areas.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
              >
                <span>
                  {a.name}{' '}
                  <span className="text-text-muted">
                    ({a.code} · {a.type})
                  </span>
                </span>
                {can('storage_area.manage') && (
                  <Button size="sm" variant="ghost" onClick={() => toggleActive(a)}>
                    {a.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')}
                  </Button>
                )}
              </li>
            ))}
        </ul>
        {can('storage_area.manage') && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <div className="flex items-end gap-2">
              <Input
                label={t('admin.masterData.locations.areaCode')}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                wrapperClassName="w-28"
              />
              <Input
                label={t('admin.masterData.locations.areaName')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                wrapperClassName="flex-1"
              />
              <Select
                label={t('admin.masterData.locations.areaType')}
                value={type}
                onValueChange={(v) => setType(v as StorageAreaType)}
                options={STORAGE_AREA_TYPES.map((s) => ({ value: s.value, label: t(s.labelKey) }))}
                wrapperClassName="w-40"
              />
            </div>
            <Button
              size="sm"
              onClick={addArea}
              loading={busy}
              disabled={!code || !name}
              className="self-start"
            >
              {t('admin.masterData.locations.addArea')}
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}

// ── Panel shell ───────────────────────────────────────────────────────────
export function MasterDataPanel() {
  const { t } = useI18n();
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  function reloadLookups() {
    api
      .get<ItemCategory[]>('/items/categories')
      .then(setCategories)
      .catch(() => {});
    api
      .get<Unit[]>('/units')
      .then(setUnits)
      .catch(() => {});
    // `pageSize` is capped at 200 backend-wide (CONTRACTS.md's pagination
    // rule, `ListItemsQueryDto`'s `@Max(200)`) — 500 here 400'd with
    // ERR_VALIDATION, silently swallowed by the `.catch(() => {})` below,
    // which is exactly why the recipe editor's "Bahan" dropdown came up
    // empty (FIX-LOADS #4): this lookup never actually populated `items`.
    api
      .get<{ rows: Item[] }>('/items?pageSize=200')
      .then((r) => setItems(r.rows))
      .catch(() => {});
  }
  useEffect(reloadLookups, []);

  return (
    <Tabs defaultValue="items">
      <TabsList>
        <TabsTrigger value="items">{t('admin.masterData.tabs.items')}</TabsTrigger>
        <TabsTrigger value="categoriesUnits">
          {t('admin.masterData.tabs.categoriesUnits')}
        </TabsTrigger>
        <TabsTrigger value="products">{t('admin.masterData.tabs.products')}</TabsTrigger>
        <TabsTrigger value="locations">{t('admin.masterData.tabs.locations')}</TabsTrigger>
      </TabsList>
      <TabsContent value="items">
        <ItemsSection categories={categories} units={units} />
      </TabsContent>
      <TabsContent value="categoriesUnits">
        <CategoriesUnitsSection categories={categories} units={units} onReload={reloadLookups} />
      </TabsContent>
      <TabsContent value="products">
        <ProductsSection items={items} units={units} />
      </TabsContent>
      <TabsContent value="locations">
        <LocationsSection />
      </TabsContent>
    </Tabs>
  );
}
