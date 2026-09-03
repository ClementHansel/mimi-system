'use client';

import { useEffect, useState } from 'react';
import { Plus, MapPin, ChevronUp, ChevronDown, Image as ImageIcon } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
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
import { Badge } from '@/components/ui/Badge';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { QtyInput } from '@/components/ui/QtyInput';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { FileUpload } from '@/components/ui/FileUpload';
import { useApiList } from './useApiList';
import { uploadProductPhoto } from './lib/attachments';
import { MasterDataIo } from './MasterDataIo';
import { ITEM_CATEGORY_IO_COLUMNS, ITEM_IO_COLUMNS, PRODUCT_IO_COLUMNS } from './lib/io-columns';
import type {
  Item,
  ItemCategory,
  Unit,
  Location,
  StorageArea,
  StorageAreaType,
  Product,
  ProductCategory,
  ProductPackageLine,
  Recipe,
  RecipeLine,
  Qty,
} from './types';
import { apiErrorText, errMsg } from '@/lib/api-error';

// ── Items ────────────────────────────────────────────────────────────────
/**
 * INGREDIENTS vs SELLABLE STOCK (owner, 2026-08-21: "separate ingredients and
 * the actual items and category for POS").
 *
 * `items` legitimately holds both — raw chicken and a bottled drink are both
 * stock — but one flat list served neither job. A cook looking for a recipe
 * ingredient and a manager checking what the till can ring up were reading the
 * same 200-row table. The filter is on `is_sellable`, which is the actual
 * distinction in the schema, not a new field invented for the UI.
 *
 * `''` = both, deliberately still available: purchasing and stock-opname care
 * about everything in the warehouse regardless of which side of this line it
 * falls on.
 */
type SellableFilter = '' | 'true' | 'false';

function ItemsSection({ categories, units }: { categories: ItemCategory[]; units: Unit[] }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [q, setQ] = useState('');
  const [sellable, setSellable] = useState<SellableFilter>('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiList<Item>('/items', {
    q,
    sellable,
    active,
    page,
    pageSize,
  });
  const [editing, setEditing] = useState<Item | null | 'new'>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  /**
   * Activate / deactivate (owner: "this need to be able to activate and
   * deactivate"). Before this there was only `DELETE /items/:id`, which set
   * `is_active = false` with no route back — an item switched off by mistake
   * needed a database fix. PATCH carries it both ways now.
   *
   * Deactivating is NOT a delete: history, recipes and past movements keep
   * referring to the row. That is why the copy says nonaktif, not hapus.
   */
  async function toggleActive(item: Item) {
    setToggling(item.id);
    try {
      await api.patch(`/items/${item.id}`, { isActive: !item.isActive });
      toast({
        title: t(
          item.isActive ? 'admin.masterData.items.deactivated' : 'admin.masterData.items.activated',
          { name: item.name },
        ),
        variant: 'success',
      });
      reload();
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    } finally {
      setToggling(null);
    }
  }

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
      header: t('admin.masterData.items.columnKind'),
      // The distinction the owner asked for, stated as a KIND rather than a
      // yes/no on a column header nobody can parse at a glance.
      render: (r) => (
        <Badge variant={r.isSellable ? 'info' : 'neutral'}>
          {t(
            r.isSellable
              ? 'admin.masterData.items.kindSellable'
              : 'admin.masterData.items.kindIngredient',
          )}
        </Badge>
      ),
    },
    {
      key: 'isActive',
      header: t('admin.masterData.items.columnStatus'),
      render: (r) => (
        <Badge variant={r.isActive ? 'success' : 'neutral'}>
          {r.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      render: (r) =>
        can('item.manage') ? (
          <Button
            size="sm"
            variant="outline"
            loading={toggling === r.id}
            onClick={(e) => {
              e.stopPropagation();
              void toggleActive(r);
            }}
          >
            {t(r.isActive ? 'common.deactivate' : 'common.activate')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input
            placeholder={t('admin.masterData.items.searchPlaceholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            wrapperClassName="w-72"
          />
          <Select
            label={t('admin.masterData.items.filterKind')}
            value={sellable}
            onValueChange={(v) => {
              setSellable(v as SellableFilter);
              setPage(1);
            }}
            placeholder={t('admin.masterData.items.kindAll')}
            options={[
              { value: 'false', label: t('admin.masterData.items.kindIngredient') },
              { value: 'true', label: t('admin.masterData.items.kindSellable') },
            ]}
            wrapperClassName="w-48"
          />
          <Select
            label={t('admin.masterData.items.columnStatus')}
            value={active}
            onValueChange={(v) => {
              setActive(v);
              setPage(1);
            }}
            placeholder={t('admin.masterData.items.statusAll')}
            options={[
              { value: 'true', label: t('admin.users.statusActive') },
              { value: 'false', label: t('admin.users.statusInactive') },
            ]}
            wrapperClassName="w-40"
          />
        </div>
        <div className="flex items-center gap-2">
          {/* Export what is on screen (the filters above are part of the
              question being asked) and import back into the same list. */}
          <MasterDataIo
            entity="items"
            titleKey="importData.entity.items"
            rows={data?.rows ?? []}
            columns={ITEM_IO_COLUMNS}
            filenameBase="item-bahan"
            canImport={can('item.manage')}
            onImported={reload}
          />
          <PermissionGate permission="item.manage">
            <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              {t('admin.masterData.items.createButton')}
            </Button>
          </PermissionGate>
        </div>
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
      setError(errMsg(err, t('errors.generic')));
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
  const [renamingCategory, setRenamingCategory] = useState<ItemCategory | null>(null);
  const [categoryRename, setCategoryRename] = useState('');
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
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Renames an item category. `PATCH /items/categories/:id` has existed in the
   * backend since M04 with nothing calling it — this list was create-only, so a
   * typo in a warehouse category was permanent and every item under it carried
   * it forever.
   */
  async function renameCategory() {
    if (!renamingCategory) return;
    setBusy(true);
    try {
      await api.patch(`/items/categories/${renamingCategory.id}`, { name: categoryRename });
      setRenamingCategory(null);
      toast({ title: t('admin.masterData.categories.renameSuccess'), variant: 'success' });
      onReload();
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
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
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-2 gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-text-primary">
            {t('admin.masterData.categories.title')}
          </h3>
          {/* Categories only. `units` is deliberately not an import entity —
              `UnitService` exposes no update, so an upsert could never edit an
              existing unit (see `IMPORT_ENTITIES`). */}
          <MasterDataIo
            entity="item_categories"
            titleKey="importData.entity.itemCategories"
            rows={categories}
            columns={ITEM_CATEGORY_IO_COLUMNS}
            filenameBase="kategori-item"
            canImport={can('item.manage')}
            onImported={onReload}
          />
        </div>
        <ul className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-2 py-1">
              <span className="flex-1">{c.name}</span>
              {can('item.manage') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRenamingCategory(c);
                    setCategoryRename(c.name);
                  }}
                >
                  {t('admin.masterData.categories.rename')}
                </Button>
              )}
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
        {renamingCategory && (
          <Modal
            open
            onClose={() => setRenamingCategory(null)}
            title={t('admin.masterData.categories.renameTitle', { name: renamingCategory.name })}
            footer={
              <>
                <Button variant="outline" onClick={() => setRenamingCategory(null)}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={renameCategory} loading={busy} disabled={!categoryRename.trim()}>
                  {t('common.save')}
                </Button>
              </>
            }
          >
            <Input
              label={t('admin.masterData.categories.name')}
              value={categoryRename}
              onChange={(e) => setCategoryRename(e.target.value)}
              required
            />
          </Modal>
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
/**
 * The POS MENU — products and their recipes, which is a different thing from the
 * warehouse's items even though a recipe joins the two. Kept visibly distinct
 * (its own category vocabulary, its own active flag) per the owner's
 * 2026-08-21 note about separating ingredients from "the actual items and
 * category for POS".
 */
function ProductsSection({
  items,
  units,
  menuCategories,
}: {
  items: Item[];
  units: Unit[];
  menuCategories: ProductCategory[];
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // The POS menu vocabulary ('Ayam', 'Minuman', 'Tambahan') — its own
  // `product_categories` table since migration 247, NOT `item_categories` and no
  // longer free text on `products`. Filtering by ID rather than by name is what
  // makes a rename harmless to this screen.
  const [categoryId, setCategoryId] = useState('');
  const [kind, setKind] = useState('');
  const [active, setActive] = useState('');
  const [toggling, setToggling] = useState<string | null>(null);
  const { data, loading, error, reload } = useApiList<Product>('/products', {
    q,
    categoryId,
    kind,
    active,
    page,
    pageSize,
  });

  /**
   * Takes a product off the POS menu, or puts it back. `products.is_active` has
   * existed since migration 012 with nothing able to change it — a sold-out or
   * seasonal line could not be hidden from the till at all, which is the half of
   * the owner's "activate and deactivate" that was entirely missing rather than
   * merely one-way.
   */
  async function toggleActive(product: Product) {
    setToggling(product.id);
    try {
      await api.patch(`/products/${product.id}`, { isActive: !product.isActive });
      toast({
        title: t(
          product.isActive
            ? 'admin.masterData.products.deactivated'
            : 'admin.masterData.products.activated',
          { name: product.name },
        ),
        variant: 'success',
      });
      reload();
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    } finally {
      setToggling(null);
    }
  }
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const [recipeFor, setRecipeFor] = useState<Product | null>(null);
  const [packageFor, setPackageFor] = useState<Product | null>(null);

  const columns: DataTableColumn<Product>[] = [
    {
      key: 'photo',
      header: t('admin.masterData.products.columnPhoto'),
      render: (r) => <ProductThumb product={r} />,
    },
    { key: 'code', header: t('admin.masterData.products.columnCode'), sortable: true },
    { key: 'name', header: t('admin.masterData.products.columnName'), sortable: true },
    { key: 'category', header: t('admin.masterData.products.columnCategory') },
    {
      key: 'kind',
      header: t('admin.masterData.products.columnKind'),
      render: (r) =>
        r.kind === 'package' ? (
          <Badge variant="info">{t('admin.masterData.products.kindPackage')}</Badge>
        ) : (
          <span className="text-text-secondary">{t('admin.masterData.products.kindProduct')}</span>
        ),
    },
    {
      key: 'price',
      header: t('admin.masterData.products.columnPrice'),
      align: 'right',
      render: (r) => formatMoney(r.price),
    },
    {
      // A package has no recipe BY DESIGN (it explodes through its members), so
      // showing "no" against one reads as a gap in the data rather than the
      // correct answer — say what it actually has instead.
      key: 'hasRecipe',
      header: t('admin.masterData.products.columnHasRecipe'),
      render: (r) =>
        r.kind === 'package'
          ? t('admin.masterData.products.memberCount', {
              count: r.packageLines?.length ?? 0,
            })
          : r.hasRecipe
            ? t('common.yes')
            : t('common.no'),
    },
    {
      key: 'isActive',
      header: t('admin.masterData.products.columnStatus'),
      render: (r) => (
        <Badge variant={r.isActive ? 'success' : 'neutral'}>
          {r.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      render: (r) => (
        <div className="flex items-center gap-2">
          {/* A recipe and a membership are mutually exclusive (a package that
              also had a BOM would double-count its ingredients on every sale),
              so offer the one that applies rather than both. */}
          {r.kind === 'package'
            ? can('product.manage') && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPackageFor(r);
                  }}
                >
                  {t('admin.masterData.products.editPackage')}
                </Button>
              )
            : can('recipe.manage') && (
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
              )}
          {r.kind === 'product' && can('product.manage') && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setPackageFor(r);
              }}
            >
              {t('admin.masterData.products.makePackage')}
            </Button>
          )}
          {can('product.manage') && (
            <Button
              size="sm"
              variant="outline"
              loading={toggling === r.id}
              onClick={(e) => {
                e.stopPropagation();
                void toggleActive(r);
              }}
            >
              {t(r.isActive ? 'common.deactivate' : 'common.activate')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input
            placeholder={t('admin.masterData.products.searchPlaceholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            wrapperClassName="w-72"
          />
          <Select
            label={t('admin.masterData.products.columnCategory')}
            value={categoryId}
            onValueChange={(v) => {
              setCategoryId(v);
              setPage(1);
            }}
            placeholder={t('admin.masterData.products.categoryAll')}
            options={menuCategories.map((c) => ({ value: c.id, label: c.name }))}
            wrapperClassName="w-48"
          />
          <Select
            label={t('admin.masterData.products.columnKind')}
            value={kind}
            onValueChange={(v) => {
              setKind(v);
              setPage(1);
            }}
            placeholder={t('admin.masterData.products.kindAll')}
            options={[
              { value: 'product', label: t('admin.masterData.products.kindProduct') },
              { value: 'package', label: t('admin.masterData.products.kindPackage') },
            ]}
            wrapperClassName="w-40"
          />
          <Select
            label={t('admin.masterData.products.columnStatus')}
            value={active}
            onValueChange={(v) => {
              setActive(v);
              setPage(1);
            }}
            placeholder={t('admin.masterData.items.statusAll')}
            options={[
              { value: 'true', label: t('admin.users.statusActive') },
              { value: 'false', label: t('admin.users.statusInactive') },
            ]}
            wrapperClassName="w-40"
          />
        </div>
        <div className="flex items-center gap-2">
          <MasterDataIo
            entity="products"
            titleKey="importData.entity.products"
            rows={data?.rows ?? []}
            columns={PRODUCT_IO_COLUMNS}
            filenameBase="produk-menu"
            canImport={can('product.manage')}
            onImported={reload}
          />
          <PermissionGate permission="product.manage">
            <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              {t('admin.masterData.products.createButton')}
            </Button>
          </PermissionGate>
        </div>
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
          menuCategories={menuCategories}
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
      {packageFor && (
        <PackageModal
          product={packageFor}
          onClose={() => setPackageFor(null)}
          onSaved={() => {
            setPackageFor(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * A product's photo in the list, or a placeholder when it has none.
 *
 * Uses `photoUrl` — the presigned one — deliberately: this row was fetched
 * seconds ago and will be re-fetched on the next `reload()`, so the 10-minute
 * expiry never bites here. `photoPath` exists for the till, which caches.
 */
function ProductThumb({ product }: { product: Product }) {
  const { t } = useI18n();
  if (!product.photoUrl) {
    return (
      <div
        className="flex size-10 items-center justify-center rounded-md bg-surface-2 text-text-tertiary"
        aria-label={t('admin.masterData.products.noPhoto')}
      >
        <ImageIcon className="size-4" aria-hidden />
      </div>
    );
  }
  return (
    // A plain <img>: the src is a presigned MinIO url, which next/image would
    // need the storage host allow-listed for, per deployment.
    <img
      src={product.photoUrl}
      alt={product.name}
      className="size-10 rounded-md object-cover"
      loading="lazy"
    />
  );
}

function ProductFormModal({
  product,
  menuCategories,
  onClose,
  onSaved,
}: {
  product: Product | null;
  menuCategories: ProductCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState(product?.code ?? '');
  const [name, setName] = useState(product?.name ?? '');
  // Defaults to the first category on create rather than to empty: `categoryId`
  // is NOT NULL server-side, so an empty select is a guaranteed 400 that the
  // user can only discover by pressing Save.
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? menuCategories[0]?.id ?? '');
  const [price, setPrice] = useState(product?.price ?? null);
  // F-POS-3 — nullable channel prices (CONTRACTS: null = same as walk-in
  // `price`, never `0`). Left `null` by default rather than pre-filled from
  // `price` — pre-filling would silently turn every existing product into
  // "channel price explicitly pinned to today's walk-in price", which then
  // stops tracking future walk-in price changes. Empty stays empty unless a
  // human types a different channel price on purpose.
  const [priceGofood, setPriceGofood] = useState(product?.priceGofood ?? null);
  const [priceShopeefood, setPriceShopeefood] = useState(product?.priceShopeefood ?? null);
  const [photo, setPhoto] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      // The photo uploads FIRST and separately (presign -> PUT -> confirm), and
      // only its resulting id goes into the product body. If the upload fails the
      // product is left untouched rather than half-saved with a broken image
      // reference — hence the distinct `uploading` state for the message.
      let photoAttachmentId: string | undefined;
      const file = photo[0];
      if (file) {
        setUploading(true);
        try {
          photoAttachmentId = await uploadProductPhoto(file);
        } finally {
          setUploading(false);
        }
      }

      const body = {
        code,
        name,
        categoryId,
        price: price ?? '0.00',
        // F-POS-3 — sent as `null`, not omitted, so clearing a previously-set
        // channel price back to "same as walk-in" actually reaches the
        // server instead of leaving the old value untouched by a partial
        // PATCH.
        priceGofood,
        priceShopeefood,
        ...(photoAttachmentId ? { photoAttachmentId } : {}),
      };
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
      setError(errMsg(err, t('errors.generic')));
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
          <Button onClick={submit} loading={submitting} disabled={!code || !name || !categoryId}>
            {uploading ? t('admin.masterData.products.photoUploading') : t('common.save')}
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
        <Select
          label={t('admin.masterData.products.category')}
          value={categoryId}
          onValueChange={setCategoryId}
          placeholder={t('admin.masterData.products.categoryPlaceholder')}
          options={menuCategories.map((c) => ({ value: c.id, label: c.name }))}
          required
        />
        <MoneyInput
          label={t('admin.masterData.products.price')}
          value={price}
          onChange={setPrice}
        />
        {/* F-POS-3 — one interface, three prices (owner). Grouped visually
            under the walk-in price with an explicit "leave empty = same as
            walk-in" hint on each — the nullable-fallback contract stated
            as plainly in the form as it is in the type. */}
        <div className="grid grid-cols-2 gap-3">
          <MoneyInput
            label={t('admin.masterData.products.priceGofood')}
            hint={t('admin.masterData.products.priceChannelHint')}
            value={priceGofood}
            onChange={setPriceGofood}
          />
          <MoneyInput
            label={t('admin.masterData.products.priceShopeefood')}
            hint={t('admin.masterData.products.priceChannelHint')}
            value={priceShopeefood}
            onChange={setPriceShopeefood}
          />
        </div>
        {product?.photoUrl && photo.length === 0 && (
          <div className="flex items-center gap-3">
            {/* Plain <img> for the same reason as ProductThumb. */}
            <img
              src={product.photoUrl}
              alt={product.name}
              className="size-16 rounded-md object-cover"
            />
            <p className="text-sm text-text-secondary">
              {t('admin.masterData.products.photoReplaceHint')}
            </p>
          </div>
        )}
        <FileUpload
          label={t('admin.masterData.products.photo')}
          hint={t('admin.masterData.products.photoHint')}
          accept="image/*"
          maxSizeMb={8}
          value={photo}
          onChange={setPhoto}
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
      setError(errMsg(err, t('errors.generic')));
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
                // No `unitCode` here: the Satuan select sitting immediately to
                // the right IS the unit, and is the editable one. Showing it
                // inside the number field as well printed the same unit twice
                // per row for no gain.
                wrapperClassName="w-32"
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

/**
 * The PACKAGE editor — a bundle's member products and how many of each.
 *
 * This is the recipe editor's sibling and deliberately looks like it, because
 * the two answer the same question ("what does selling one of these consume?")
 * at different levels: a recipe lists raw `items`, a package lists other
 * PRODUCTS. Only one of them can apply to a given product — a package that also
 * carried a recipe would count its ingredients twice per sale, which the
 * database refuses outright (migration 248).
 *
 * Saving here CONVERTS a plain product into a package in one request; clearing
 * every line converts it back. Both are one server call precisely so a product
 * is never left as a bundle with no members — a sellable that would consume no
 * stock at all.
 */
function PackageModal({
  product,
  onClose,
  onSaved,
}: {
  product: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [lines, setLines] = useState<{ memberProductId: string; qty: Qty | null }[]>([]);
  const [candidates, setCandidates] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    // Members must be PLAIN products (packages do not nest) and must not be this
    // product itself — filtering here rather than letting the server reject the
    // save keeps the impossible choices out of the dropdown entirely.
    void Promise.all([
      api.get<ProductPackageLine[]>(`/products/${product.id}/package`).catch(() => []),
      api
        .get<{ rows: Product[] }>('/products?kind=product&active=true&pageSize=200')
        .then((r) => r.rows)
        .catch(() => [] as Product[]),
    ])
      .then(([existing, all]) => {
        if (!alive) return;
        setLines(
          existing.length > 0
            ? existing.map((l) => ({ memberProductId: l.memberProductId, qty: l.qty }))
            : [{ memberProductId: '', qty: '1.000' }],
        );
        setCandidates(all.filter((p) => p.id !== product.id));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [product.id]);

  function addLine() {
    setLines((prev) => [...prev, { memberProductId: '', qty: '1.000' }]);
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  function updateLine(index: number, patch: Partial<{ memberProductId: string; qty: Qty | null }>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  const filled = lines.filter((l) => l.memberProductId && l.qty);
  const duplicate = new Set(filled.map((l) => l.memberProductId)).size !== filled.length;

  /**
   * Sum of the members at their own menu prices — the number the package price
   * is a discount against.
   *
   * `Number()` is acceptable HERE and nowhere near a saved value: this is a
   * display-only comparison, and the money that actually gets stored is the
   * decimal string `MoneyInput` produces on the product form (CONTRACTS §0 —
   * money never becomes a float on a write path).
   */
  const membersTotal = filled.reduce((sum, l) => {
    const member = candidates.find((c) => c.id === l.memberProductId);
    if (!member) return sum;
    return sum + Number(member.price) * Number(l.qty);
  }, 0);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      if (filled.length === 0) {
        // No members left means "this is not a bundle any more", which is a
        // DELETE — a PUT with an empty list is rejected server-side, correctly,
        // because an empty package is a sellable that consumes nothing.
        await api.delete(`/products/${product.id}/package`);
      } else {
        await api.put(`/products/${product.id}/package`, {
          lines: filled.map((l, i) => ({
            memberProductId: l.memberProductId,
            qty: l.qty,
            sortOrder: i,
          })),
        });
      }
      toast({ title: t('admin.masterData.products.packageSaved'), variant: 'success' });
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.masterData.products.packageTitle', { name: product.name })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} disabled={loading || duplicate}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        {duplicate && (
          <p className="text-sm text-danger-600">
            {t('admin.masterData.products.packageDuplicate')}
          </p>
        )}
        <p className="text-sm text-text-secondary">{t('admin.masterData.products.packageHint')}</p>

        {loading ? (
          <p className="text-sm text-text-secondary">{t('common.loading')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {lines.map((line, i) => (
              <div key={i} className="flex items-end gap-2">
                <Select
                  label={i === 0 ? t('admin.masterData.products.member') : undefined}
                  value={line.memberProductId}
                  onValueChange={(v) => updateLine(i, { memberProductId: v })}
                  placeholder={t('admin.masterData.products.memberPlaceholder')}
                  options={candidates.map((c) => ({
                    value: c.id,
                    label: `${c.name} — ${formatMoney(c.price)}`,
                  }))}
                  wrapperClassName="flex-1"
                />
                <QtyInput
                  label={i === 0 ? t('admin.masterData.products.memberQty') : undefined}
                  value={line.qty}
                  onChange={(v) => updateLine(i, { qty: v })}
                  wrapperClassName="w-28"
                />
                <Button size="sm" variant="ghost" onClick={() => removeLine(i)}>
                  {t('common.remove')}
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={addLine}
              className="self-start"
              leftIcon={<Plus className="size-4" />}
            >
              {t('admin.masterData.products.addMember')}
            </Button>
          </div>
        )}

        {/* The whole point of a bundle is that it costs less than its parts.
            Showing both numbers together makes a mispriced package obvious at
            the moment someone sets it, rather than after a week of selling it
            at a loss. */}
        {filled.length > 0 && (
          <div className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-text-secondary">
                {t('admin.masterData.products.membersTotal')}
              </span>
              <span>{formatMoney(membersTotal.toFixed(2))}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">
                {t('admin.masterData.products.packagePrice')}
              </span>
              <span>{formatMoney(product.price)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>{t('admin.masterData.products.packageSaving')}</span>
              <span
                className={
                  membersTotal - Number(product.price) < 0 ? 'text-danger-600' : 'text-success-700'
                }
              >
                {formatMoney((membersTotal - Number(product.price)).toFixed(2))}
              </span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── POS menu categories ──────────────────────────────────────────────────
/**
 * The till's CATEGORY CHIP ROW, as editable data.
 *
 * These are `product_categories` (migration 247), not `item_categories`: one is
 * how a cashier finds "Minuman" on the menu, the other is how the warehouse
 * groups "Bumbu" on a shelf. They were conflated in neither the schema nor this
 * screen, but the menu side had no management surface at all — the category was
 * free text on every product row, so it could not be renamed (every product had
 * to be re-edited), reordered (the till sorted alphabetically because
 * alphabetical was the only order a text column could give), or retired.
 *
 * ORDER IS THE POINT of the up/down controls: the chip row is what a cashier
 * scans during a queue, so putting Ayam first and Tambahan last is an
 * operational decision, not decoration.
 */
function MenuCategoriesSection({
  categories,
  onReload,
}: {
  categories: ProductCategory[];
  onReload: () => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<ProductCategory | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);

  const manage = can('product.manage');

  async function run(fn: () => Promise<unknown>, successKey: string) {
    setBusy(true);
    try {
      await fn();
      toast({ title: t(successKey), variant: 'success' });
      onReload();
      return true;
    } catch (err) {
      // The server refuses to retire a category that still has products under it
      // and says how many — surface that message verbatim rather than a generic
      // failure, because the count is the actionable part.
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const ok = await run(
      () => api.post('/products/categories', { name: newName }),
      'admin.masterData.menuCategories.createSuccess',
    );
    if (ok) setNewName('');
  }

  async function rename() {
    if (!renaming) return;
    const ok = await run(
      () => api.patch(`/products/categories/${renaming.id}`, { name: renameValue }),
      'admin.masterData.menuCategories.renameSuccess',
    );
    if (ok) setRenaming(null);
  }

  /**
   * Moves one row and sends the WHOLE resulting order in one request, rather
   * than PATCHing two `sortOrder` values. Order is a property of the list: two
   * sequential writes leave the chip row briefly wrong, and permanently wrong if
   * the second one fails.
   */
  async function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= categories.length) return;
    const reordered = [...categories];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    await run(
      () => api.put('/products/categories/order', { ids: reordered.map((c) => c.id) }),
      'admin.masterData.menuCategories.reorderSuccess',
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <div>
        <h3 className="font-medium text-text-primary">
          {t('admin.masterData.menuCategories.title')}
        </h3>
        <p className="text-sm text-text-secondary">
          {t('admin.masterData.menuCategories.description')}
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {categories.length === 0 && (
          <li className="px-3 py-4 text-sm text-text-secondary">
            {t('admin.masterData.menuCategories.empty')}
          </li>
        )}
        {categories.map((c, i) => (
          <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="flex-1">
              {c.name}
              {!c.isActive && (
                <Badge variant="neutral" className="ml-2">
                  {t('admin.users.statusInactive')}
                </Badge>
              )}
            </span>
            <span className="text-text-secondary">
              {t('admin.masterData.menuCategories.productCount', { count: c.productCount })}
            </span>
            {manage && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={t('admin.masterData.menuCategories.moveUp')}
                >
                  <ChevronUp className="size-4" aria-hidden />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || i === categories.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={t('admin.masterData.menuCategories.moveDown')}
                >
                  <ChevronDown className="size-4" aria-hidden />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRenaming(c);
                    setRenameValue(c.name);
                  }}
                >
                  {t('admin.masterData.menuCategories.rename')}
                </Button>
                {/* Retiring is only offered when nothing points at the category.
                    The server enforces this too; hiding the button avoids
                    offering an action that can only ever fail. */}
                {c.isActive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || c.productCount > 0}
                    title={
                      c.productCount > 0
                        ? t('admin.masterData.menuCategories.inUseHint')
                        : undefined
                    }
                    onClick={() =>
                      run(
                        () => api.delete(`/products/categories/${c.id}`),
                        'admin.masterData.menuCategories.deactivateSuccess',
                      )
                    }
                  >
                    {t('common.deactivate')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => api.patch(`/products/categories/${c.id}`, { isActive: true }),
                        'admin.masterData.menuCategories.activateSuccess',
                      )
                    }
                  >
                    {t('common.activate')}
                  </Button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      {manage && (
        <div className="flex items-end gap-2">
          <Input
            label={t('admin.masterData.menuCategories.name')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            wrapperClassName="flex-1"
          />
          <Button size="sm" onClick={add} loading={busy} disabled={!newName.trim()}>
            {t('admin.masterData.menuCategories.createButton')}
          </Button>
        </div>
      )}

      {renaming && (
        <Modal
          open
          onClose={() => setRenaming(null)}
          title={t('admin.masterData.menuCategories.renameTitle', { name: renaming.name })}
          footer={
            <>
              <Button variant="outline" onClick={() => setRenaming(null)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={rename} loading={busy} disabled={!renameValue.trim()}>
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Input
              label={t('admin.masterData.menuCategories.name')}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              required
            />
            {/* Worth saying out loud: the products keep pointing at the same row,
                so the new name shows up on every till at the next catalog
                refresh with no per-product editing. That was the whole reason
                for the table. */}
            <p className="text-sm text-text-secondary">
              {t('admin.masterData.menuCategories.renameHint', {
                count: renaming.productCount,
              })}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Locations & Storage Areas ────────────────────────────────────────────
/**
 * Outlets and warehouses — the full CRUD, in the Data Master tab that owns them.
 *
 * The C, R and U halves already existed (create button, row-click edit, storage
 * areas drawer, geofence fields). What was missing was the rest of the lifecycle:
 * an outlet could be created but never CLOSED from the UI, and a deactivated one
 * could not be found, because this list always requested every location and
 * showed `isActive` as text with no way to act on it. The backend had the
 * endpoint the whole time (`DELETE /locations/:id`, a soft `is_active = false`)
 * — the same shape of gap `lib/nav.ts` records for gudang's purchasing link: a
 * capability that existed and was unreachable.
 *
 * DEACTIVATE, NEVER DELETE, and the copy says so. A location is referenced by
 * every Surat Jalan, stock balance, opname and shift that ever touched it;
 * removing the row would orphan all of it. Closing an outlet hides it from the
 * pickers and leaves its history intact — which is why the confirm dialog talks
 * about closing rather than deleting.
 */
function LocationsSection() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  /**
   * '' = every location, 'true' = active only, 'false' = closed only. Sent as
   * the endpoint's own `active` filter rather than filtered client-side, so a
   * closed outlet is reachable even when the active ones fill several pages.
   */
  const [active, setActive] = useState('');
  const { data, loading, error, reload } = useApiList<Location>('/locations', {
    page,
    pageSize,
    ...(active ? { active } : {}),
  });
  const [editing, setEditing] = useState<Location | null | 'new'>(null);
  const [areasFor, setAreasFor] = useState<Location | null>(null);
  /** The location awaiting a close/reopen confirmation — never acted on directly from a row click. */
  const [lifecycleFor, setLifecycleFor] = useState<Location | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  async function applyLifecycle() {
    if (!lifecycleFor) return;
    setLifecycleBusy(true);
    try {
      if (lifecycleFor.isActive) {
        // The DELETE route, not a PATCH: it is the one that emits the
        // `deactivated` sync op devices listen for.
        await api.delete(`/locations/${lifecycleFor.id}`);
      } else {
        await api.patch(`/locations/${lifecycleFor.id}`, { isActive: true });
      }
      toast({
        title: t(
          lifecycleFor.isActive
            ? 'admin.masterData.locations.deactivated'
            : 'admin.masterData.locations.reactivated',
        ),
        variant: 'success',
      });
      setLifecycleFor(null);
      reload();
    } catch (err) {
      toast({
        title: t('table.error'),
        description: apiErrorText(err),
        variant: 'danger',
      });
    } finally {
      setLifecycleBusy(false);
    }
  }

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
      // A badge, not text: with the closed-only filter now reachable, "which of
      // these is shut" has to be answerable at a glance down the column.
      render: (r) => (
        <Badge variant={r.isActive ? 'success' : 'neutral'} size="sm">
          {r.isActive ? t('admin.users.statusActive') : t('admin.users.statusInactive')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-2">
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
          {can('location.manage') && (
            <Button
              size="sm"
              variant={r.isActive ? 'ghost' : 'outline'}
              onClick={(e) => {
                e.stopPropagation();
                setLifecycleFor(r);
              }}
            >
              {t(r.isActive ? 'common.deactivate' : 'common.activate')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Select
          label={t('admin.masterData.locations.columnStatus')}
          value={active}
          onValueChange={(v) => {
            setActive(v);
            setPage(1);
          }}
          options={[
            { value: '', label: t('common.all') },
            { value: 'true', label: t('admin.users.statusActive') },
            { value: 'false', label: t('admin.users.statusInactive') },
          ]}
          wrapperClassName="w-48"
        />
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
      {lifecycleFor && (
        <Modal
          open
          onClose={() => setLifecycleFor(null)}
          title={t(
            lifecycleFor.isActive
              ? 'admin.masterData.locations.deactivateTitle'
              : 'admin.masterData.locations.reactivateTitle',
            { name: lifecycleFor.name },
          )}
          footer={
            <>
              <Button variant="outline" onClick={() => setLifecycleFor(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant={lifecycleFor.isActive ? 'danger' : 'primary'}
                loading={lifecycleBusy}
                onClick={applyLifecycle}
              >
                {t(lifecycleFor.isActive ? 'common.deactivate' : 'common.activate')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-secondary">
            {t(
              lifecycleFor.isActive
                ? 'admin.masterData.locations.deactivateWarning'
                : 'admin.masterData.locations.reactivateWarning',
            )}
          </p>
        </Modal>
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
  /**
   * GEOFENCE CENTRE + RADIUS (owner, 2026-08-21: "make the attendance system
   * properly so it can be geo fenced at 200M of the outlet location").
   *
   * These fields did not exist. Coordinates were seed-only, so any outlet
   * created through this form had NULL lat/lng and every check-in there failed
   * with "This location has no geofence center configured" — an attendance
   * outage created by adding an outlet, with nothing in this form to hint at
   * the cause.
   *
   * The radius is left EMPTY by default and empty means inherit
   * `hr.geofence_radius_m` (200 m). Typing a number makes this outlet an
   * override — which is why the field says which default it is overriding
   * rather than pre-filling 200 and turning every new outlet into a permanent
   * override at today's value.
   */
  const [latitude, setLatitude] = useState(location?.latitude ?? '');
  const [longitude, setLongitude] = useState(location?.longitude ?? '');
  const [radius, setRadius] = useState(
    location?.geofenceRadiusIsOverride ? String(location.geofenceRadiusM) : '',
  );
  // FR-LOG-03. '' is the "not agreed yet" state and is sent as null — the
  // Select's placeholder option, not a missing value. An outlet nobody has
  // decided about must read as undecided rather than adopt a schedule.
  const [cadence, setCadence] = useState<string>(location?.deliveryCadence ?? '');
  const [locating, setLocating] = useState(false);
  const inheritedRadiusM =
    location && !location.geofenceRadiusIsOverride ? location.geofenceRadiusM : null;
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Capture the phone's current position as the centre. This is how the centre
   * actually gets set correctly: someone stands at the outlet and taps once.
   * Typing coordinates from a map is where transposed lat/lng and dropped
   * decimals come from — and a centre that is wrong by a kilometre locks the
   * whole outlet out of clocking in.
   */
  function useCurrentPosition() {
    if (!navigator.geolocation) {
      setError(t('admin.masterData.locations.geoUnsupported'));
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(pos.coords.latitude.toFixed(6));
        setLongitude(pos.coords.longitude.toFixed(6));
        setLocating(false);
      },
      () => {
        setError(t('admin.masterData.locations.geoDenied'));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

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
      latitude: latitude || undefined,
      longitude: longitude || undefined,
      // Empty means inherit — sent as null so a PATCH can CLEAR an override,
      // which `undefined` (omitted) could never express.
      geofenceRadiusM: radius === '' ? null : Number(radius),
      // Null, not undefined: clearing an agreed cadence back to "not agreed"
      // has to be expressible, and an omitted key would leave it untouched.
      deliveryCadence: cadence === '' ? null : cadence,
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
      setError(errMsg(err, t('errors.generic')));
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

        {/*
          FR-LOG-03 — outlets only. A warehouse ships rather than receives, so
          a delivery cadence on one is meaningless and offering the field there
          would invite someone to set it.
        */}
        {type === 'outlet' && (
          <Select
            label={t('admin.masterData.locations.cadence')}
            value={cadence}
            onValueChange={setCadence}
            options={[
              { value: '', label: t('admin.masterData.locations.cadenceNone') },
              { value: 'daily', label: t('admin.masterData.locations.cadenceDaily') },
              { value: 'twice_weekly', label: t('admin.masterData.locations.cadenceTwiceWeekly') },
              {
                value: 'thrice_weekly',
                label: t('admin.masterData.locations.cadenceThriceWeekly'),
              },
              { value: 'weekly', label: t('admin.masterData.locations.cadenceWeekly') },
            ]}
          />
        )}

        <div className="col-span-2 flex flex-col gap-1 border-t border-border pt-3">
          <p className="text-sm font-semibold text-text-primary">
            {t('admin.masterData.locations.geofenceTitle')}
          </p>
          <p className="text-xs text-text-muted">{t('admin.masterData.locations.geofenceHint')}</p>
        </div>
        <Input
          label={t('admin.masterData.locations.latitude')}
          value={latitude}
          onChange={(e) => setLatitude(e.target.value)}
          placeholder="-1.265000"
          hint={t('admin.masterData.locations.coordsHint')}
        />
        <Input
          label={t('admin.masterData.locations.longitude')}
          value={longitude}
          onChange={(e) => setLongitude(e.target.value)}
          placeholder="116.831000"
        />
        <div className="col-span-2 flex flex-wrap items-end gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<MapPin className="size-4" />}
            loading={locating}
            onClick={useCurrentPosition}
          >
            {t('admin.masterData.locations.useCurrentPosition')}
          </Button>
          <Input
            label={t('admin.masterData.locations.radius')}
            type="number"
            inputMode="numeric"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            placeholder={
              inheritedRadiusM
                ? t('admin.masterData.locations.radiusInherited', { radius: inheritedRadiusM })
                : t('admin.masterData.locations.radiusDefault')
            }
            hint={t('admin.masterData.locations.radiusHint')}
            wrapperClassName="w-56"
          />
        </div>
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
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
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
  // `includeInactive` so the menu-category editor can show a retired row and
  // offer to reactivate it; the product form filters to active itself.
  const [menuCategories, setMenuCategories] = useState<ProductCategory[]>([]);

  /**
   * Every lookup here is rendered with `.map`/`.filter`, so a response that is
   * not an array does not degrade — it throws during render and takes the whole
   * Master Data screen to a blank error page. `asArray` keeps a shape surprise
   * (a proxy returning an error envelope, an endpoint mid-deploy) to an empty
   * list, which the sections already handle.
   */
  function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  function reloadLookups() {
    api
      .get<ProductCategory[]>('/products/categories?includeInactive=true')
      .then((r) => setMenuCategories(asArray<ProductCategory>(r)))
      .catch(() => {});
    api
      .get<ItemCategory[]>('/items/categories')
      .then((r) => setCategories(asArray<ItemCategory>(r)))
      .catch(() => {});
    api
      .get<Unit[]>('/units')
      .then((r) => setUnits(asArray<Unit>(r)))
      .catch(() => {});
    // `pageSize` is capped at 200 backend-wide (CONTRACTS.md's pagination
    // rule, `ListItemsQueryDto`'s `@Max(200)`) — 500 here 400'd with
    // ERR_VALIDATION, silently swallowed by the `.catch(() => {})` below,
    // which is exactly why the recipe editor's "Bahan" dropdown came up
    // empty (FIX-LOADS #4): this lookup never actually populated `items`.
    api
      .get<{ rows: Item[] }>('/items?pageSize=200')
      .then((r) => setItems(asArray<Item>(r?.rows)))
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
        <TabsTrigger value="menuCategories">
          {t('admin.masterData.tabs.menuCategories')}
        </TabsTrigger>
        <TabsTrigger value="locations">{t('admin.masterData.tabs.locations')}</TabsTrigger>
      </TabsList>
      <TabsContent value="items">
        <ItemsSection categories={categories} units={units} />
      </TabsContent>
      <TabsContent value="categoriesUnits">
        <CategoriesUnitsSection categories={categories} units={units} onReload={reloadLookups} />
      </TabsContent>
      <TabsContent value="products">
        <ProductsSection
          items={items}
          units={units}
          menuCategories={menuCategories.filter((c) => c.isActive)}
        />
      </TabsContent>
      <TabsContent value="menuCategories">
        <MenuCategoriesSection categories={menuCategories} onReload={reloadLookups} />
      </TabsContent>
      <TabsContent value="locations">
        <LocationsSection />
      </TabsContent>
    </Tabs>
  );
}
