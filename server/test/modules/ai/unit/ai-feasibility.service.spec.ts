import { AiFeasibilityService, InventoryNames } from '@modules/ai/services/ai-feasibility.service';

describe('AiFeasibilityService', () => {
  let service: AiFeasibilityService;

  beforeEach(() => {
    service = new AiFeasibilityService();
  });

  const sampleInventory = `
App: Demo CRM

Pages (with the components on each):
- Customers: Text "Customers header", Table "Customers table", Button "Add customer"
- Orders (no components yet)

Data sources in use:
- Postgres production (postgresql)

Queries:
- list_customers on Postgres production (list_rows)
- recent_orders (list_rows)

Past approved builds (most recent conversations first):
- PRD: Build a simple CRM
  Built: created customers table
`;

  describe('parseInventoryNames', () => {
    it('extracts pages, components, queries and data sources from inventory text', () => {
      const names: InventoryNames = service.parseInventoryNames(sampleInventory);

      expect(names.pages).toEqual(expect.arrayContaining(['Customers', 'Orders']));
      expect(names.components).toEqual(expect.arrayContaining(['Customers header', 'Customers table', 'Add customer']));
      expect(names.queries).toEqual(expect.arrayContaining(['list_customers', 'recent_orders']));
      expect(names.dataSources).toEqual(expect.arrayContaining(['Postgres production']));
    });

    it('returns empty collections for an empty inventory', () => {
      const names = service.parseInventoryNames('');

      expect(names.pages).toEqual([]);
      expect(names.components).toEqual([]);
      expect(names.queries).toEqual([]);
      expect(names.dataSources).toEqual([]);
    });
  });

  describe('assess', () => {
    it('returns feasible for a clear build request', () => {
      const verdict = service.assess('Build a customer CRM with deals and contacts', sampleInventory);

      expect(verdict.type).toBe('feasible');
    });

    it('returns feasible when the request mentions an existing page', () => {
      const verdict = service.assess('Add a search box to the Customers page', sampleInventory);

      expect(verdict.type).toBe('feasible');
    });

    it('returns feasible when the request mentions an existing component', () => {
      const verdict = service.assess('Change the label of Customers table', sampleInventory);

      expect(verdict.type).toBe('feasible');
    });

    it('returns feasible when the request mentions an existing query', () => {
      const verdict = service.assess('Show the results of recent_orders in a chart', sampleInventory);

      expect(verdict.type).toBe('feasible');
    });

    it('returns feasible when @-references point to an existing inventory name', () => {
      const verdict = service.assess('Update this', sampleInventory, [
        { type: 'component', id: 'c1', name: 'Customers table' },
      ]);

      expect(verdict.type).toBe('feasible');
    });

    it('returns infeasible when the request names a non-existent page', () => {
      const verdict = service.assess('Add a button to the Dashboard page', sampleInventory);

      expect(verdict.type).toBe('infeasible');
      expect((verdict as any).messageForUser).toContain('Dashboard');
      expect((verdict as any).messageForUser).toContain('Customers');
    });

    it('returns infeasible when @-references point to nothing in the inventory', () => {
      const verdict = service.assess('Update this', sampleInventory, [
        { type: 'component', id: 'ghost', name: 'Ghost widget' },
      ]);

      expect(verdict.type).toBe('infeasible');
      expect((verdict as any).messageForUser).toContain('Ghost widget');
    });

    it('returns noData for an empty request', () => {
      const verdict = service.assess('', sampleInventory);

      expect(verdict.type).toBe('noData');
      expect((verdict as any).recommendations.length).toBeGreaterThan(0);
    });

    it('returns noData for a very short request', () => {
      const verdict = service.assess('hi', sampleInventory);

      expect(verdict.type).toBe('noData');
    });

    it('returns noData for a vague request with no names and no build intent', () => {
      const verdict = service.assess('something nice maybe later', sampleInventory);

      expect(verdict.type).toBe('noData');
    });

    it('recommendations are returned as strings for noData', () => {
      const verdict = service.assess('???', sampleInventory);

      expect(verdict.type).toBe('noData');
      expect((verdict as any).recommendations.every((r: string) => typeof r === 'string')).toBe(true);
    });
  });
});
