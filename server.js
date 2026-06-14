const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n=== [BFF PRODUÇÃO CONSOLIDADO] IMPLANTANDO FILTROS ESTRICTOS: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. AUTENTICAÇÃO CENTRALIZADA (SED)
        // ----------------------------------------------------------
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        const raCompletoFormatado = `${cdUsuario8}${user.slice(-3)}`.toUpperCase();

        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        };

        // ----------------------------------------------------------
        // 2. EXTRAÇÃO DE ESCOLA E CALENDÁRIO (SED)
        // ----------------------------------------------------------
        let infoTurma = {};
        let schoolId = null;
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data) && turmaRes.data.length > 0) infoTurma = turmaRes.data[0];
            else if (turmaRes.data?.data) infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            schoolId = infoTurma?.CodigoEscola || infoTurma?.CD_ESCOLA;
        } catch (err) { console.error(`[BFF] Erro ao recuperar turma: ${err.message}`); }

        // Ancoragem temporal dinâmica do 2º Bimestre obtida via logs do NotebookLM
        let dataInicioBimestre = new Date("2026-04-23T00:00:00Z"); 
        if (schoolId) {
            try {
                const bimestreRes = await axios.get(`${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Bimestre/ListarBimestres?escolaId=${schoolId}`, sedConfig);
                const listaBimestres = bimestreRes.data?.data || bimestreRes.data || [];
                if (Array.isArray(listaBimestres)) {
                    const bAtivo = listaBimestres.find(b => b.Ativo === true || b.NumeroBimestre === 2);
                    if (bAtivo?.DataInicio) {
                        dataInicioBimestre = new Date(bAtivo.DataInicio);
                    }
                }
            } catch (errBim) { console.error(`[BFF] Erro ao buscar calendário: ${errBim.message}`); }
        }

        // ----------------------------------------------------------
        // 3. HANDSHAKE IP.TV
        // ----------------------------------------------------------
        let authTokenIptv = null;
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                { httpsAgent, headers: { 'x-api-realm': 'edusp', 'x-api-platform': 'webclient', 'Content-Type': 'application/json' }}
            );
            authTokenIptv = iptvHandshake.data?.auth_token;
        } catch (err) { console.error(`[BFF] Erro Handshake IPTV: ${err.message}`); }

        // ----------------------------------------------------------
        // 4. PARALELISMO TÉCNICO DE ROTAS E FILTRAGEM (IP.TV)
        // ----------------------------------------------------------
        let pendentes = 0;
        let expiradas = 0;
        let avaliacoes = 0;
        let redacoes = 0;

        if (authTokenIptv) {
            try {
                const configIptvBase = {
                    httpsAgent,
                    headers: { 'x-api-key': authTokenIptv, 'Host': 'edusp', 'Accept': 'application/json' }
                };

                const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
                const rooms = roomsRes.data?.rooms || [];
                
                const targets = [];
                rooms.forEach(r => {
                    if (r.name) targets.push(`publication_target=${r.name}`);
                    if (Array.isArray(r.category_ids)) {
                        r.category_ids.forEach(id => targets.push(`publication_target=${id}`));
                    }
                });

                if (targets.length === 0) targets.push('publication_target=all');
                const targetQuery = targets.join('&');

                // Execução paralela em lote (Flow idêntico ao Diagnosticado pelo NotebookLM)
                const [pendentesRaw, expiradasRaw, redacoesRaw, surveyRes] = await Promise.all([
                    axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=false&filter_expired=true&is_exam=false&is_essay=false&with_answer=true&answer_statuses=draft&answer_statuses=pending`, configIptvBase),
                    axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=true&filter_expired=false&is_exam=false&is_essay=false&with_answer=true&answer_statuses=draft&answer_statuses=pending`, configIptvBase),
                    axios.get(`${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&is_essay=true&filter_expired=true&with_answer=true`, configIptvBase),
                    axios.get(`${CONSTANTS.BASE_IPTV}/survey/todo/count?${targetQuery}&filter_expired=true&with_answer=true&answer_statuses=draft`, configIptvBase)
                ]);

                // Aplicação das regras de corte estritas por answer_id e Linha Temporal do Bimestre
                pendentes = (pendentesRaw.data || []).filter(t =>
                    t.answer_id === null && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                ).length;

                expiradas = (expiradasRaw.data || []).filter(t =>
                    t.answer_id === null && new Date(t.expire_at || t.end_date) >= dataInicioBimestre
                ).length;

                redacoes = (redacoesRaw.data || []).filter(t =>
                    t.answer_id === null && new Date(t.publish_at || t.start_date) >= dataInicioBimestre
                ).length;

                // Captura direta do motor de pesquisas (Surveys) mapeado como Avaliações
                avaliacoes = surveyRes.data?.count || surveyRes.data?.required_count || 0;

            } catch (errBatch) {
                console.error(`[BFF] Erro no processamento do lote IP.TV: ${errBatch.message}`);
            }
        }

        // ----------------------------------------------------------
        // RETORNO PADRONIZADO E HIGIENIZADO
        // ----------------------------------------------------------
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: raCompletoFormatado, 
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: pendentes,
                expiradas: expiradas,
                avaliacoes: avaliacoes,
                redacoes: redacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro Crítico: ${error.message}`);
        res.status(500).json({ error: "Erro de agregação no barramento principal do BFF." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Produção com Promise.all operando na porta ${PORT}`));
