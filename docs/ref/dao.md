# Data Access Objects

The first step of using ormnomnom is to require it and apply it to a function.
This function won't be touched in any visible way; it serves as the factory for
row instances.

```
const orm = require('ormnomnom')

const dao = orm(MyFunction, {id: true}) 
```

Given a function and an object describing the columns the backing table has,
ormnomnom will return a "data access object," or **"DAO"**. The DAO exposes all
of the functionality that ormnomnom provides. Primarily, the DAO provides
access to [QuerySets][ref-queryset], which represent postgres operations as a
set of their results.

## Public API

```javascript
const orm = require('ormnomnom')
```

##### `orm.setConnection(Function → Promise<{connection, release}>)`

This method provides ORMnomnom with a user-supplied function to call for
attaining database connections. The function provided should return a promise
for an object with two properties, `connection` and `release`. `connection` should
be a [pg][def-pg] [`Client`][def-pg-client] object. `release` should be a function
that returns `Client` to a pool, or shuts the client down.

```javascript
const orm = require('ormnomnom')
const pg = require('pg')

// use pg's built-in connection pooling
orm.setConnection(() => {
  return new Promise((resolve, reject) => {
    pg.connect('postgres://localhost/database', (err, connection, release) => {
      if (err) {
        return reject(err)
      }
      return resolve({connection, release})
    })
  })
})
```

##### `orm(Model, Schema[, options]) → DAO<Model>`

##### `orm.fk(Model[, options]) → ForeignKeyDefinition`

Create a foreign key definition suitable for use in a [model
schema][def-model-schema].

##### `orm.joi`

The [joi][def-joi] version used by this installation of ORMnomnom. For use
when defining the [model schema][def-model-schema].

##### `DAO<Model>#getOrCreate(Object) → Promise<[Boolean, Model]>`

Attempt to fetch and materialize a row using `Object` as a
[`Clause`][def-clause]. If no row exists, insert a new row using `Object`
as the source data. Returns a `Promise` for a two element array. The first
element is a boolean indicating whether or not a new row had to be inserted.
The second element is a model instance.

##### `DAO<Model>#all() → QuerySet<Model>`

[See `QuerySet#all`](./queryset.md#querysetmodelall).

##### `DAO<Model>#filter(Clause) → QuerySet<Model>`

[See `QuerySet#filter`](./queryset.md#querysetfilterclause).

##### `DAO<Model>#exclude(Clause) → QuerySet<Model>`

[See `QuerySet#exclude`](./queryset.md#querysetexcludeclause).

##### `DAO<Model>#get(Clause) → Promise<Model>`

[See `QuerySet#get`](./queryset.md#querysetgetclause).

##### `DAO<Model>#create(Object) → Promise<Model>`

[See `QuerySet#create`](./queryset.md#querysetcreatedata).

##### `DAO<Model>#update(Data) → Promise<Number>`

[See `QuerySet#update`](./queryset.md#querysetupdatedata).

##### `DAO<Model>#delete() → Promise<Number>`

[See `QuerySet#delete`](./queryset.md#querysetdelete).

### Errors

##### `orm.NotFound`
##### `DAO<Model>.NotFound`

Raised when the query was expected to represent at least one row, but no
rows were found.

##### `orm.MultipleObjectsReturned`
##### `DAO<Model>.MultipleObjectsReturned`

Raised when the query was expected to represent at most one row, but multiple
rows were found.

##### `orm.Conflict`
##### `DAO<Model>.Conflict`

[def-joi]: https://www.npmjs.org/package/joi
[def-clause]: ./queryset.md#clauses
[ref-queryset]: ./queryset.md
[def-pg]: https://www.npmjs.org/package/pg
[def-pg-client]: https://github.com/brianc/node-postgres/wiki/Client
