'use strict'

const symbols = require('./shared-symbols.js')
const classToDAOSym = symbols.clsToDAO
const querySetSym = symbols.querySet

module.exports = createQueryClass()

const QueryStream = require('pg-query-stream')
const concat = require('concat-stream')
const Promise = require('bluebird')
const streams = require('stream')
const joi = require('joi')

const Transform = streams.Transform
const Readable = streams.Readable

const once = require('once')

const NEGATE_SYM = Symbol('negation')

const DELETE = Symbol('delete')
const INSERT = Symbol('insert')
const UPDATE = Symbol('update')
const SELECT = Symbol('select')
const COUNT = Symbol('count')

const daoSym = Symbol('dao')

function createQueryClass () {
  return class QuerySet {
    constructor (dao, parent) {
      this._transformer = null
      this._action = parent === null ? SELECT : null
      this._filter = null
      this._slice = null
      this._data = null
      this._order = null
      this._columns = null
      this._parent = parent
      this[daoSym] = dao
    }

    [querySetSym] () {
    }

    count () {
      var qs = new QuerySet(this[daoSym], this)
      qs._action = COUNT
      return qs.valuesList(['count']).then(xs => xs[0])
    }

    order (by) {
      by = Array.isArray(by) ? by : [by]
      var qs = new QuerySet(this[daoSym], this)
      qs._order = by
      return qs
    }

    get (query) {
      return this.filter(query).slice(0, 2).then((xs) => {
        switch (xs.length) {
          case 0:
            throw new this[daoSym].NotFound()
          case 2:
            throw new this[daoSym].MultipleObjectsReturned()
        }
        return xs[0]
      })
    }

    filter (query) {
      var qs = new QuerySet(this[daoSym], this)
      qs._filter = query
      return qs
    }

    exclude (query) {
      var qs = new QuerySet(this[daoSym], this)
      query[NEGATE_SYM] = true
      qs._filter = query
      return qs
    }

    slice (start, end) {
      var qs = new QuerySet(this[daoSym], this)
      switch (arguments.length) {
        case 1:
          qs._slice = [start, Infinity]
          break
        case 2:
          qs._slice = [start, end]
          break
      }
      return qs
    }

    delete () {
      var qs = new QuerySet(this[daoSym], this)
      qs._action = DELETE
      qs._transformer = countTransform
      return qs.then(xs => xs[0])
    }
    update (data) {
      var qs = new QuerySet(this[daoSym], this)
      qs._action = UPDATE
      qs._data = data
      qs._transformer = countTransform
      return qs.then(xs => xs[0])
    }
    create (data) {
      var qs = new QuerySet(this[daoSym], this)
      qs._action = INSERT
      qs._data = data
      return Promise.all([
        Promise.props(data),
        qs
      ]).spread((data, xs) => decorateData(xs[0], data, this[daoSym]))
    }

    values (values) {
      var qs = new QuerySet(this[daoSym], this)
      values = Array.isArray(values) ? values : [values]
      qs._columns = values
      qs._transformer = this[daoSym].createValuesTransformer(values)
      return qs
    }
    valuesList (values) {
      var qs = new QuerySet(this[daoSym], this)
      values = Array.isArray(values) ? values : [values]
      qs._columns = values
      qs._transformer = this[daoSym].createValuesListTransformer(values)
      return qs
    }

    raw () {
      return materialize(this, (db, values, sql, release) => {
        return {db, values, sql, release}
      })
    }
    createStream () {
      var mapper = createMapper(this)
      materialize(this).then(function (stream) {
        stream.on('error', err => {
          mapper.emit('error', err)
        })
        stream.pipe(mapper)
      }, function (err) {
        mapper.emit('error', err)
      })
      return mapper
    }

    pipe (dst, opts) {
      return this.createStream().pipe(dst, opts)
    }
    then (onsuccess, onfail) {
      var deferred = Promise.defer()
      var reject = once(deferred.reject.bind(deferred))

      var promise = deferred.promise

      if (onsuccess && onfail) {
        promise = promise.then(onsuccess, onfail)
      } else if (onsuccess) {
        promise = promise.then(onsuccess)
      } else if (onfail) {
        promise = promise.catch(onfail)
      }

      try {
        var src = this.createStream()
      } catch (err) {
        reject(err)
        return promise
      }
      var dst = concat({encoding: 'object'}, items => {
        deferred.resolve(items)
      })
      src.once('error', reject)
      dst.once('error', reject)
      src.pipe(dst)

      return promise
    }
    get sql () {
      return materialize(this, (db, values, sql, release) => {
        release()
        return sql
      })
    }
  }
}

function * iterate (qs) {
  var current = qs
  while (current) {
    yield current
    current = current._parent
  }
}

function materialize (queryset, destination) {
  var action = null
  var order = null
  var filter = []
  var slice = []
  var data = null
  for (var xs of iterate(queryset)) {
    action = action || xs._action
    data = data || xs._data
    order = order || xs._order
    if (xs._filter) {
      filter.unshift(xs._filter)
    }
    if (xs._slice) {
      slice.unshift(xs._slice)
    }
  }

  slice.unshift([0, Infinity])
  slice = slice.reduce(function (current, next) {
    return [
      current[0] + next[0],
      Math.min(current[0] + next[1], current[1])
    ]
  }, [0, Infinity])

  var getData = action === INSERT || action === UPDATE
    ? Promise.props(data || {})
    : Promise.cast({})

  var getWhere = Promise.all(filter.map(function (xs) {
    return (
      Array.isArray(xs)
      ? Promise.all(xs.map(rewriteOperationInToSelect))
      : Promise.props(rewriteOperationInToSelect(xs))
    ).then(function (ys) {
      ys[NEGATE_SYM] = xs[NEGATE_SYM]
      return ys
    })
  }))
  var connection = queryset[daoSym].getConnection()

  var retVal = Promise.all([
    getData,
    getWhere,
    Promise.resolve(connection).get('connection'),
    Promise.resolve(connection).get('release')
  ]).spread(buildQuery)

  return Promise.all([
    connection,
    retVal.reflect()
  ]).spread(function (conn, status) {
    if (status.isRejected()) {
      return conn.release(status.reason())
    }
  }).return(retVal)

  function buildQuery (data, where, db, release) {
    var values = []
    var result = null
    switch (action) {
      case UPDATE:
        destination = destination || queryCount
        result = buildUpdate(
          queryset[daoSym], db, data, where, slice, order, values)
        break
      case DELETE:
        destination = destination || queryCount
        result = buildDelete(
          queryset[daoSym], db, where, slice, order, values)
        break
      case SELECT:
        destination = destination || queryMap
        result = buildSelect(
          queryset[daoSym], db, where, slice, order, values, queryset._columns)
        break
      case COUNT:
        destination = destination || queryMap
        result = buildCount(
          queryset[daoSym], db, where, slice, order, values)
        break
      case INSERT:
        destination = destination || queryMap
        result = buildInsert(
          queryset[daoSym], db, data, values)
        break
    }
    return destination(db, values, result, release)
  }
}

function rewriteOperationInToSelect (filter) {
  const out = {}
  for (var key in filter) {
    if (filter[key] && !filter[key][querySetSym]) {
      out[key] = filter[key]
      continue
    }

    if (!filter[key]._columns ||
        filter[key]._columns.length !== 1) {
      out[key] = filter[key]
      continue
    }

    const split = key.split(':')
    if (split[1] !== 'in' &&
        split[1] !== 'notIn') {
      out[key] = filter[key]
      continue
    }

    const newKey = `${split[0]}:raw`
    const op = split[1] === 'in' ? 'IN' : 'NOT IN'
    out[newKey] = filter[key].raw().then(query => {
      query.release()
      return (col, push) => {
        var len = 0
        while (query.values.length) {
          len = len || push(query.values.shift())
        }
        if (len) {
          query.sql = query.sql.replace(
            /\$(\d+)/g,
            (all, match) => `$${Number(match) + len - 1}`
          )
        }
        return `${col} ${op} (${query.sql})`
      }
    })
  }
  return out
}

function queryCount (db, values, sql, release) {
  var stream = new Readable({
    objectMode: true,
    read (n) {}
  })
  db.query(sql, values, function (err, rows) {
    if (err) {
      return stream.emit('error', err)
    }
    stream.push(rows.rowCount)
    stream.push(null)
  })
  stream.once('error', release)
  stream.once('end', release)
  return stream
}

function queryMap (db, values, sql, release) {
  var query = new QueryStream(sql, values)
  query.once('error', release)
  query.once('end', release)
  return db.query(query)
}

function decorateData (instance, data, dao) {
  if (!instance) {
    return
  }
  for (var key in data) {
    if (data[key] &&
        data[key].constructor &&
        data[key].constructor[classToDAOSym] &&
        dao.ddl[key] &&
        dao.ddl[key].isFK &&
        dao.ddl[key].isForwardRelation) {
      instance[key] = data[key]
    }
  }
  return instance
}

function createMapper (queryset) {
  var transformer = null
  for (var xs of iterate(queryset)) {
    transformer = xs._transformer
    if (transformer) {
      break
    }
  }
  transformer = transformer || queryset[daoSym].createObjectTransformer()
  return new Transform({
    objectMode: true,
    transform (chunk, enc, cb) {
      transformer(chunk, out => this.push(out))
      cb()
    }
  })
}

function buildUpdate (dao, db, data, where, bounds, order, values) {
  var keys = []
  var preppedData = {}
  var validator = {}
  for (var key in data) {
    if (!dao.ddl[key]) {
      continue
    }
    if (dao.ddl[key].isFK && !dao.ddl[key].isForwardRelation) {
      continue
    }
    var col = dao.ddl[key]
    var val = col.dbPrepData(data[key])
    preppedData[key] = val
    validator[key] = col.getDataValidator()
    keys.push(`"${col.column}"`)
    values.push(val)
  }

  var result = joi.validate(preppedData, validator)
  if (result.error) {
    throw result.error
  }

  var onlyFields = [dao.primaryKeyName]
  const mainClause = `
    UPDATE "${dao.tableName}"
    SET (${keys}) = (${keys.map((key, idx) => '$' + (idx + 1))})
  `
  if (!where.length) {
    return mainClause
  }

  // ORDER, LIMIT, OFFSET are only available via subquery.
  if (order || bounds[0] !== 0 || isFinite(bounds[1])) {
    return `
      ${mainClause}
      WHERE "${dao.tableName}"."${dao.primaryKeyName}" IN (
        ${buildSelect(dao, db, where, bounds, order, values, onlyFields)}
      )
    `
  }
  var seenJoin = new Map()
  var joinClause = []
  var fromClause = new Set()
  for (var join of getJoins(dao, where, seenJoin)) {
    fromClause.add(join.to.tableName)
    joinClause.push(`
      "${join.from.tableName}"."${join.on.column}" =
      "${join.to.tableName}"."${join.on.remoteColumn()}"
    `)
  }

  var whereClause = '(' + where.map(clause => {
    var result = null
    var mapped = whereClauseToSQL(dao, clause, values)
    if (Array.isArray(clause)) {
      for (var i = 0; i < clause.length; ++i) {
        result = joi.validate(clause[i], mapped.validator[i])
        if (result.error) {
          throw result.error
        }
      }
    } else {
      result = joi.validate(clause, mapped.validator)
      if (result.error) {
        throw result.error
      }
    }
    return mapped.sql
  }).join(') AND (') + ')'

  var whereStr = joinClause.length
    ? (whereClause === '()'
      ? joinClause.join(' AND ')
      : `(${joinClause.join(' AND ')}) AND ${whereClause}`)
    : (whereClause === '()'
      ? 'TRUE'
      : whereClause)

  return `
    ${mainClause}
    ${fromClause.size ? 'FROM ' : ''}${Array.from(fromClause).join(', ')}
    WHERE ${whereStr}
  `
}

function buildDelete (dao, db, where, bounds, order, values) {
  const onlyFields = [dao.primaryKeyName]
  const mainClause = `DELETE FROM ${dao.tableName}`

  if (!where.length) {
    return mainClause
  }

  // ORDER, LIMIT, OFFSET are only available via subquery.
  if (order || bounds[0] !== 0 || isFinite(bounds[1])) {
    return `
      ${mainClause}
      WHERE "${dao.tableName}"."${dao.primaryKeyName}" IN (
        ${buildSelect(dao, db, where, bounds, order, values, onlyFields)}
      )
    `
  }
  var seenJoin = new Map()
  var joinClause = []
  var fromClause = new Set()
  for (var join of getJoins(dao, where, seenJoin)) {
    fromClause.add(join.to.tableName)
    joinClause.push(`
      "${join.from.tableName}"."${join.on.column}" =
      "${join.to.tableName}"."${join.on.remoteColumn()}"
    `)
  }

  var whereClause = '(' + where.map(clause => {
    var result = null
    var mapped = whereClauseToSQL(dao, clause, values)
    if (Array.isArray(clause)) {
      for (var i = 0; i < clause.length; ++i) {
        result = joi.validate(clause[i], mapped.validator[i])
        if (result.error) {
          throw result.error
        }
      }
    } else {
      result = joi.validate(clause, mapped.validator)
      if (result.error) {
        throw result.error
      }
    }
    return mapped.sql
  }).join(') AND (') + ')'

  var whereStr = joinClause.length
    ? (whereClause === '()'
      ? joinClause.join(' AND ')
      : `(${joinClause.join(' AND ')}) AND ${whereClause}`)
    : (whereClause === '()'
      ? 'TRUE'
      : whereClause)

  return `
    ${mainClause}
    ${fromClause.size ? 'FROM ' : ''}${Array.from(fromClause).join(', ')}
    WHERE ${whereStr}
  `
}

function buildCount (dao, db, where, bounds, order, values) {
  var rawFields = [`COUNT(*) AS "${dao.tableName}.count"`]
  return buildSelect(dao, db, where, bounds, [], values, [], rawFields)
}

function buildSelect (dao, db, where, bounds, order, values, onlyFields, rawFields) {
  onlyFields = onlyFields ? new Set(
    onlyFields.map(xs => `${dao.tableName}.${xs}`)) : onlyFields
  const filterOnlyFields = onlyFields ? xs => onlyFields.has(xs) : Boolean
  var joinClause = []
  var selectClause = [
    dao.contributeColumns(dao.tableName, filterOnlyFields)
  ]
  var seenJoin = new Map()
  var pfx = new Map()
  var seenSelect = new Set([dao])
  pfx.set(dao, dao.tableName)

  var addJoin = join => {
    pfx.set(join.to, pfx.get(join.from) + '.' + join.on.name)
    joinClause.push(`
      LEFT ${join.on.nullable ? 'OUTER ' : ''}JOIN "${join.to.tableName}"
      ON (
        "${join.from.tableName}"."${join.on.column}" =
        "${join.to.tableName}"."${join.on.remoteColumn()}"
      )
    `)
  }

  order = (order || []).map(col => {
    var order = 'ASC'
    if (col[0] === '-') {
      col = col.slice(1)
      order = 'DESC'
    }
    var info = getColInfo(dao, col)
    for (var join of getJoinFromSubclause({[col]: true}, dao, seenJoin)) {
      addJoin(join)
    }
    return `"${info.dao.tableName}"."${info.col.column}" ${order}`
  })
  for (var join of getJoins(dao, where, seenJoin)) {
    addJoin(join)
    if (!seenSelect.has(join.to)) {
      selectClause.push(
        join.to.contributeColumns(pfx.get(join.to), filterOnlyFields)
      )
    }
    seenSelect.add(join.to)
  }

  var offset = bounds[0]
  var limit = bounds[1] - bounds[0]
  var whereClause = '(' + where.map(clause => {
    var result = null
    var mapped = whereClauseToSQL(dao, clause, values)
    if (Array.isArray(clause)) {
      for (var i = 0; i < clause.length; ++i) {
        result = joi.validate(clause[i], mapped.validator[i])
        if (result.error) {
          throw result.error
        }
      }
    } else {
      result = joi.validate(clause, mapped.validator)
      if (result.error) {
        throw result.error
      }
    }
    return mapped.sql
  }).join(') AND (') + ')'

  selectClause = selectClause.concat(rawFields || []).reduce(
    (acc, rhs) => acc.concat(rhs),
    []
  ).filter(Boolean)
  return `
    SELECT ${selectClause} FROM
    "${dao.tableName}"
    ${joinClause.join(' ')}
    WHERE ${whereClause === '()' ? 'TRUE' : whereClause}
    ${order.length ? 'ORDER BY ' + order : ''}
    LIMIT ${isFinite(limit) ? limit : 'ALL'}
    OFFSET ${offset}
  `
}

function buildInsert (dao, db, data, values) {
  var keys = []
  var numbers = []
  var preppedData = {}
  for (var key in data) {
    if (!dao.ddl[key]) {
      continue
    }
    var col = dao.ddl[key]
    var val = col.dbPrepData(data[key])
    preppedData[key] = val
  }

  var allKeys = []
  var validator = {}
  for (var ddlKey in dao.ddl) {
    if (dao.ddl[ddlKey].isFK && !dao.ddl[ddlKey].isForwardRelation) {
      continue
    }
    if (!dao.ddl[ddlKey].isFK) {
      allKeys.push(dao.ddl[ddlKey].name)
    }
    if (ddlKey === dao.primaryKeyName && data[ddlKey] === undefined) {
      continue
    }
    validator[ddlKey] = dao.ddl[ddlKey].getDataValidator()
  }

  var result = joi.validate(preppedData, validator, {
    allowUnknown: true
  })
  if (result.error) {
    throw result.error
  }

  for (var resultKey in result.value) {
    if (!dao.ddl[resultKey] || !(resultKey in validator)) {
      continue
    }
    keys.push(`"${dao.ddl[resultKey].column}"`)
    numbers.push(values.push(result.value[resultKey]))
  }

  return `
    INSERT INTO "${dao.tableName}"
    (${keys}) VALUES ($${numbers.join(', $')})
    RETURNING ${allKeys.map(
      xs => '"' + xs + '" AS "' + dao.tableName + '.' + xs + '"'
    )}
  `
}

function whereClauseToSQL (dao, clause, values) {
  var validator = {}
  if (Array.isArray(clause)) {
    var bits = clause.map(xs => whereClauseToSQL(dao, xs, values))
    var sql = bits.map((xs, idx) => ((validator[idx] = xs.validator), xs.sql))
    return {
      sql: `${clause[NEGATE_SYM] ? 'NOT ' : ''}(${sql.join(') OR (')})`,
      validator
    }
  }
  var out = []
  for (var key in clause) {
    var info = key.split(':')
    var colInfo = getColInfo(dao, info[0])
    var op = info[1]
    validator[key] = colInfo.col.getQueryValidator(op)
    out.push(operationMap(
      `"${colInfo.dao.tableName}"."${colInfo.col.column}"`,
      op || 'eq',
      clause[key],
      value => values.push(colInfo.col.dbPrepQuery(value))
    ))
  }
  return {
    sql: (clause[NEGATE_SYM] ? 'NOT ' : '') +
      '(' + out.join(') AND (') + ')',
    validator
  }
}

function getColInfo (dao, colspec) {
  var bits = colspec.split('.')
  var curDao = dao
  for (var j = 0; j < bits.length - 1; ++j) {
    curDao = curDao.ddl[bits[j]].getAPI()
  }
  return {
    col: curDao.ddl[bits[j]],
    dao: curDao
  }
}

function operationMap (col, op, val, push) {
  return {
    eq () {
      return `${col} = $${push(val)}`
    },
    neq () {
      return `${col} != $${push(val)}`
    },
    raw () {
      return val(col, push)
    },
    contains () {
      return `${col} like $${push('%' + val.replace(/%/g, '%%') + '%')}`
    },
    startsWith () {
      return `${col} like $${push(val.replace(/%/g, '%%') + '%')}`
    },
    endsWith () {
      return `${col} like $${push('%' + val.replace(/%/g, '%%'))}`
    },
    in () {
      if (val.length < 1) {
        return `false`
      }
      return `${col} in (${val.map(xs => '$' + push(xs))})`
    },
    notIn () {
      if (val.length < 1) {
        return `true`
      }
      return `${col} not in (${val.map(xs => '$' + push(xs))})`
    },
    isNull () {
      return `${col} is ${val ? '' : 'NOT'} NULL`
    },
    lt () {
      return `${col} < $${push(val)}`
    },
    gt () {
      return `${col} > $${push(val)}`
    },
    lte () {
      return `${col} <= $${push(val)}`
    },
    gte () {
      return `${col} >= $${push(val)}`
    },
    iContains () {
      return `UPPER(${col}) like UPPER($${push('%' + val.replace(/%/g, '%%') + '%')})`
    },
    iStartsWith () {
      return `UPPER(${col}) like UPPER($${push(val.replace(/%/g, '%%') + '%')})`
    },
    iEndsWith () {
      return `UPPER(${col}) like UPPER($${push('%' + val.replace(/%/g, '%%'))})`
    }
  }[op]()
}

function * getJoins (dao, clause, seenJoin) {
  for (var i = 0; i < clause.length; ++i) {
    var subclause = clause[i]
    if (Array.isArray(subclause)) {
      for (var xs of subclause) {
        yield * getJoinFromSubclause(xs, dao, seenJoin)
      }
    } else {
      yield * getJoinFromSubclause(subclause, dao, seenJoin)
    }
  }
  return seenJoin
}

function * getJoinFromSubclause (subclause, dao, seenJoin) {
  for (var key in subclause) {
    var isNew = false
    var cols = key.split(':')[0]
    var bits = cols.split('.')
    var curDao = dao
    for (var j = 0; j < bits.length - 1; ++j) {
      if (!seenJoin.has(curDao)) {
        isNew = true
        seenJoin.set(curDao, new Map())
      }
      var next = seenJoin.get(curDao)
      var nextDao = curDao.ddl[bits[j]].getAPI()
      if (!next.has(nextDao)) {
        isNew = true
        next.set(nextDao, new Set())
      }
      if (!next.get(nextDao).has(bits[j])) {
        isNew = true
        next.get(nextDao).add(bits[j])
      }
      if (isNew) {
        yield {
          from: curDao,
          to: nextDao,
          on: curDao.ddl[bits[j]]
        }
        isNew = false
      }
      curDao = nextDao
    }
  }
}

function countTransform (row, push) {
  return push(row)
}
